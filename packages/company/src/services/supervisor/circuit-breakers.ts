/**
 * AgentSupervisor — Circuit Breakers (Sprint 4 Phase 2.3).
 *
 * Three independent breakers, each with its own sliding window.
 *
 *   1. **Per-agent breaker**  — N failed recovery attempts in window W
 *      → agent QUARANTINED. Prevents thrashing on one stuck agent that
 *      keeps re-failing recovery (e.g. provider outage, persistent bug).
 *
 *   2. **Per-role breaker**   — N consecutive failures of the same role
 *      in window W → role quarantined for cooldownMs (no new spawns).
 *      Prevents respawning a broken role config (e.g. all `qa` agents
 *      crash on boot because env var missing).
 *
 *   3. **Global breaker**     — N incidents/min across whole supervisor
 *      → enter READ-ONLY mode (emit incidents only, skip recovery
 *      actions) for cooldownMs. Prevents recovery thrashing during a
 *      systemic problem (provider region outage, DB lock storm).
 *
 * **Pure module** — no I/O, no clock except `now` arg. Caller (the
 * supervisor) feeds it events + queries it before acting. This keeps
 * the breakers trivially testable + lets the supervisor reason about
 * its actions without timing flakiness.
 *
 * **Env tunables** read on construction (defaults shown):
 *   - `MCP_SUPERVISOR_AGENT_BREAKER_LIMIT`       = 3
 *   - `MCP_SUPERVISOR_AGENT_BREAKER_WINDOW_MS`   = 600_000  (10min)
 *   - `MCP_SUPERVISOR_ROLE_BREAKER_LIMIT`        = 3
 *   - `MCP_SUPERVISOR_ROLE_BREAKER_WINDOW_MS`    = 600_000  (10min)
 *   - `MCP_SUPERVISOR_ROLE_QUARANTINE_MS`        = 300_000  (5min)
 *   - `MCP_SUPERVISOR_GLOBAL_BREAKER_LIMIT`      = 20
 *   - `MCP_SUPERVISOR_GLOBAL_BREAKER_WINDOW_MS`  = 60_000   (1min)
 *   - `MCP_SUPERVISOR_GLOBAL_READ_ONLY_MS`       = 60_000   (1min)
 */

export interface CircuitBreakerConfig {
  /** Per-agent: how many failed recovery attempts trip the breaker. */
  agentLimit: number;
  /** Per-agent: window (ms) over which attempts are counted. */
  agentWindowMs: number;
  /** Per-role: how many failures of the same role trip the breaker. */
  roleLimit: number;
  /** Per-role: window (ms) over which failures are counted. */
  roleWindowMs: number;
  /** Per-role: cooldown duration (ms) once the role is quarantined. */
  roleQuarantineMs: number;
  /** Global: how many incidents in `globalWindowMs` trip read-only mode. */
  globalLimit: number;
  /** Global: window (ms) over which incidents are counted. */
  globalWindowMs: number;
  /** Global: cooldown duration (ms) in read-only mode. */
  globalReadOnlyMs: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = Object.freeze({
  agentLimit: 3,
  agentWindowMs: 10 * 60_000,
  roleLimit: 3,
  roleWindowMs: 10 * 60_000,
  roleQuarantineMs: 5 * 60_000,
  globalLimit: 20,
  globalWindowMs: 60_000,
  globalReadOnlyMs: 60_000,
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a config from env vars, falling back to defaults per-field. */
export function configFromEnv(): CircuitBreakerConfig {
  return {
    agentLimit: envInt('MCP_SUPERVISOR_AGENT_BREAKER_LIMIT', DEFAULT_BREAKER_CONFIG.agentLimit),
    agentWindowMs: envInt(
      'MCP_SUPERVISOR_AGENT_BREAKER_WINDOW_MS',
      DEFAULT_BREAKER_CONFIG.agentWindowMs,
    ),
    roleLimit: envInt('MCP_SUPERVISOR_ROLE_BREAKER_LIMIT', DEFAULT_BREAKER_CONFIG.roleLimit),
    roleWindowMs: envInt(
      'MCP_SUPERVISOR_ROLE_BREAKER_WINDOW_MS',
      DEFAULT_BREAKER_CONFIG.roleWindowMs,
    ),
    roleQuarantineMs: envInt(
      'MCP_SUPERVISOR_ROLE_QUARANTINE_MS',
      DEFAULT_BREAKER_CONFIG.roleQuarantineMs,
    ),
    globalLimit: envInt(
      'MCP_SUPERVISOR_GLOBAL_BREAKER_LIMIT',
      DEFAULT_BREAKER_CONFIG.globalLimit,
    ),
    globalWindowMs: envInt(
      'MCP_SUPERVISOR_GLOBAL_BREAKER_WINDOW_MS',
      DEFAULT_BREAKER_CONFIG.globalWindowMs,
    ),
    globalReadOnlyMs: envInt(
      'MCP_SUPERVISOR_GLOBAL_READ_ONLY_MS',
      DEFAULT_BREAKER_CONFIG.globalReadOnlyMs,
    ),
  };
}

/** Returned by `getRoleQuarantine` to expose the cooldown end time. */
export interface RoleQuarantineInfo {
  role: string;
  quarantinedUntilMs: number;
  failureTimestamps: ReadonlyArray<number>;
}

/** Snapshot for dashboards / introspection. */
export interface BreakerStatusSnapshot {
  agents: Array<{ agentRunId: number; recentAttempts: number; tripped: boolean }>;
  roles: Array<{ role: string; recentFailures: number; quarantinedUntilMs: number | null }>;
  globalIncidentsInWindow: number;
  readOnlyUntilMs: number | null;
}

/**
 * In-memory circuit breakers. Single-process; supervisor is one
 * singleton per worker so this matches the supervisor's lifecycle.
 * No persistence — restart resets all counters. Acceptable because
 * counters represent recent activity within the window.
 */
export class CircuitBreakers {
  private readonly cfg: CircuitBreakerConfig;
  private readonly agentAttempts = new Map<number, number[]>();
  private readonly roleFailures = new Map<string, number[]>();
  private readonly roleQuarantineUntil = new Map<string, number>();
  private globalIncidents: number[] = [];
  private readOnlyUntilMs: number | null = null;

  constructor(cfg: Partial<CircuitBreakerConfig> = {}) {
    this.cfg = { ...DEFAULT_BREAKER_CONFIG, ...cfg };
  }

  /** Return a deep-copied config snapshot (callers shouldn't mutate). */
  getConfig(): CircuitBreakerConfig {
    return { ...this.cfg };
  }

  // ─── Per-agent ────────────────────────────────────────────────

  /**
   * Record a FAILED recovery attempt for an agent. Successful recovery
   * attempts must NOT call this — they would falsely trip the breaker.
   * Caller is the supervisor's `runRecoveryActionFor` after a dispatch
   * returns `ok: false`.
   *
   * Returns true when the recorded attempt trips the breaker now (so
   * the supervisor can transition to QUARANTINED immediately rather
   * than waiting for the next tick).
   */
  recordAgentFailure(agentRunId: number, nowMs: number): boolean {
    const list = this.agentAttempts.get(agentRunId) ?? [];
    list.push(nowMs);
    this.pruneOlderThan(list, nowMs - this.cfg.agentWindowMs);
    this.agentAttempts.set(agentRunId, list);
    return list.length >= this.cfg.agentLimit;
  }

  /** True when agent has ≥ N failed recovery attempts in the window. */
  isAgentTripped(agentRunId: number, nowMs: number): boolean {
    const list = this.agentAttempts.get(agentRunId);
    if (!list || list.length === 0) return false;
    this.pruneOlderThan(list, nowMs - this.cfg.agentWindowMs);
    return list.length >= this.cfg.agentLimit;
  }

  /** Clear the agent's history. Called when the agent reaches TERMINAL. */
  clearAgent(agentRunId: number): void {
    this.agentAttempts.delete(agentRunId);
  }

  // ─── Per-role ─────────────────────────────────────────────────

  /**
   * Record a role failure (subordinate of this role died / failed
   * recovery / etc). Returns true when the recorded failure quarantines
   * the role now (caller can refuse new spawns immediately).
   */
  recordRoleFailure(role: string, nowMs: number): boolean {
    const list = this.roleFailures.get(role) ?? [];
    list.push(nowMs);
    this.pruneOlderThan(list, nowMs - this.cfg.roleWindowMs);
    this.roleFailures.set(role, list);
    if (list.length >= this.cfg.roleLimit) {
      // Quarantine extends from now (not from first failure) so
      // back-to-back failures keep refreshing the cooldown.
      this.roleQuarantineUntil.set(role, nowMs + this.cfg.roleQuarantineMs);
      return true;
    }
    return false;
  }

  /** Returns quarantine info when the role is currently quarantined. */
  getRoleQuarantine(role: string, nowMs: number): RoleQuarantineInfo | null {
    const until = this.roleQuarantineUntil.get(role);
    if (until == null || until <= nowMs) {
      if (until != null) this.roleQuarantineUntil.delete(role);
      return null;
    }
    const list = this.roleFailures.get(role) ?? [];
    return {
      role,
      quarantinedUntilMs: until,
      failureTimestamps: list.slice(),
    };
  }

  /** Operator override — release a role from quarantine early. */
  releaseRole(role: string): boolean {
    const hadQuarantine = this.roleQuarantineUntil.delete(role);
    this.roleFailures.delete(role);
    return hadQuarantine;
  }

  // ─── Global ───────────────────────────────────────────────────

  /**
   * Record an incident (any kind). Returns true when the recorded
   * incident trips read-only mode now.
   */
  recordIncident(nowMs: number): boolean {
    this.globalIncidents.push(nowMs);
    this.globalIncidents = this.globalIncidents.filter(
      (ts) => ts >= nowMs - this.cfg.globalWindowMs,
    );
    if (this.globalIncidents.length >= this.cfg.globalLimit) {
      this.readOnlyUntilMs = nowMs + this.cfg.globalReadOnlyMs;
      return true;
    }
    return false;
  }

  /** True when supervisor is in read-only mode (skip recovery actions). */
  isReadOnlyMode(nowMs: number): boolean {
    if (this.readOnlyUntilMs == null) return false;
    if (this.readOnlyUntilMs <= nowMs) {
      this.readOnlyUntilMs = null;
      return false;
    }
    return true;
  }

  /** Operator override — exit read-only mode early. */
  releaseReadOnly(): boolean {
    const was = this.readOnlyUntilMs !== null;
    this.readOnlyUntilMs = null;
    return was;
  }

  // ─── Snapshot ─────────────────────────────────────────────────

  status(nowMs: number): BreakerStatusSnapshot {
    const agents: BreakerStatusSnapshot['agents'] = [];
    for (const [agentRunId, list] of this.agentAttempts) {
      this.pruneOlderThan(list, nowMs - this.cfg.agentWindowMs);
      agents.push({
        agentRunId,
        recentAttempts: list.length,
        tripped: list.length >= this.cfg.agentLimit,
      });
    }
    const roles: BreakerStatusSnapshot['roles'] = [];
    for (const [role, list] of this.roleFailures) {
      this.pruneOlderThan(list, nowMs - this.cfg.roleWindowMs);
      const until = this.roleQuarantineUntil.get(role) ?? null;
      const active = until != null && until > nowMs ? until : null;
      roles.push({ role, recentFailures: list.length, quarantinedUntilMs: active });
    }
    this.globalIncidents = this.globalIncidents.filter(
      (ts) => ts >= nowMs - this.cfg.globalWindowMs,
    );
    return {
      agents,
      roles,
      globalIncidentsInWindow: this.globalIncidents.length,
      readOnlyUntilMs: this.readOnlyUntilMs && this.readOnlyUntilMs > nowMs
        ? this.readOnlyUntilMs
        : null,
    };
  }

  /** Test helper — reset everything. */
  clearAllForTests(): void {
    this.agentAttempts.clear();
    this.roleFailures.clear();
    this.roleQuarantineUntil.clear();
    this.globalIncidents = [];
    this.readOnlyUntilMs = null;
  }

  // ─── internals ────────────────────────────────────────────────

  /** Mutates `list` in place to drop entries older than `threshold`. */
  private pruneOlderThan(list: number[], threshold: number): void {
    // Common case: oldest entries are at the head. Walk from the front.
    let drop = 0;
    while (drop < list.length && list[drop] < threshold) drop++;
    if (drop > 0) list.splice(0, drop);
  }
}

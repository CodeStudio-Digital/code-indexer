/**
 * Tests for CircuitBreakers (Sprint 4 Phase 2.3).
 *
 * Locks in:
 *   - Per-agent: tripps at limit, sliding window prunes stale entries
 *   - Per-role: trips → quarantine; cooldown extends on new failures;
 *     auto-release after cooldown; operator releaseRole works
 *   - Global: incidents/min → read-only; auto-clears after readOnlyMs
 *   - clearAgent removes attempts (called on TERMINAL transitions)
 *   - status snapshot reflects current counts
 *   - config from env overrides defaults; bad env values fall back
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CircuitBreakers,
  DEFAULT_BREAKER_CONFIG,
  configFromEnv,
} from '../circuit-breakers.js';

describe('per-agent breaker', () => {
  it('does not trip below the limit', () => {
    const cb = new CircuitBreakers({ agentLimit: 3, agentWindowMs: 60_000 });
    expect(cb.recordAgentFailure(1, 0)).toBe(false);
    expect(cb.recordAgentFailure(1, 100)).toBe(false);
    expect(cb.isAgentTripped(1, 200)).toBe(false);
  });

  it('trips exactly at the limit', () => {
    const cb = new CircuitBreakers({ agentLimit: 3, agentWindowMs: 60_000 });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 100);
    expect(cb.recordAgentFailure(1, 200)).toBe(true);
    expect(cb.isAgentTripped(1, 300)).toBe(true);
  });

  it('prunes stale entries — old failures fall off the window', () => {
    const cb = new CircuitBreakers({ agentLimit: 3, agentWindowMs: 1_000 });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 100);
    cb.recordAgentFailure(1, 200);
    expect(cb.isAgentTripped(1, 300)).toBe(true);
    // 2_000 is past the window — all three are stale
    expect(cb.isAgentTripped(1, 2_000)).toBe(false);
  });

  it('clearAgent wipes history', () => {
    const cb = new CircuitBreakers({ agentLimit: 2, agentWindowMs: 60_000 });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 100);
    expect(cb.isAgentTripped(1, 200)).toBe(true);
    cb.clearAgent(1);
    expect(cb.isAgentTripped(1, 300)).toBe(false);
  });

  it('separate agents have separate counters', () => {
    const cb = new CircuitBreakers({ agentLimit: 2, agentWindowMs: 60_000 });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 100);
    expect(cb.isAgentTripped(1, 200)).toBe(true);
    expect(cb.isAgentTripped(2, 200)).toBe(false);
  });
});

describe('per-role breaker', () => {
  it('does not quarantine below the limit', () => {
    const cb = new CircuitBreakers({ roleLimit: 3, roleWindowMs: 60_000, roleQuarantineMs: 1_000 });
    expect(cb.recordRoleFailure('qa', 0)).toBe(false);
    expect(cb.getRoleQuarantine('qa', 100)).toBeNull();
  });

  it('quarantines at the limit; getRoleQuarantine returns until + history', () => {
    const cb = new CircuitBreakers({ roleLimit: 3, roleWindowMs: 60_000, roleQuarantineMs: 5_000 });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100);
    expect(cb.recordRoleFailure('qa', 200)).toBe(true);
    const q = cb.getRoleQuarantine('qa', 300);
    expect(q).not.toBeNull();
    expect(q?.quarantinedUntilMs).toBe(200 + 5_000);
    expect(q?.failureTimestamps).toHaveLength(3);
  });

  it('refreshing failure extends cooldown', () => {
    const cb = new CircuitBreakers({ roleLimit: 2, roleWindowMs: 60_000, roleQuarantineMs: 1_000 });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100); // trips
    const firstUntil = cb.getRoleQuarantine('qa', 200)?.quarantinedUntilMs;
    cb.recordRoleFailure('qa', 500); // still in window — refreshes
    const secondUntil = cb.getRoleQuarantine('qa', 600)?.quarantinedUntilMs;
    expect(secondUntil).toBeGreaterThan(firstUntil ?? 0);
  });

  it('auto-releases after cooldown', () => {
    const cb = new CircuitBreakers({ roleLimit: 2, roleWindowMs: 60_000, roleQuarantineMs: 1_000 });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100); // trips → until 1100
    expect(cb.getRoleQuarantine('qa', 500)).not.toBeNull();
    expect(cb.getRoleQuarantine('qa', 1_200)).toBeNull();
  });

  it('releaseRole drops both quarantine and failure history', () => {
    const cb = new CircuitBreakers({ roleLimit: 2, roleWindowMs: 60_000, roleQuarantineMs: 5_000 });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100);
    expect(cb.releaseRole('qa')).toBe(true);
    expect(cb.getRoleQuarantine('qa', 200)).toBeNull();
    // After release, history is cleared — needs full limit to re-trip
    cb.recordRoleFailure('qa', 300);
    expect(cb.getRoleQuarantine('qa', 400)).toBeNull();
  });

  it('separate roles have separate counters', () => {
    const cb = new CircuitBreakers({ roleLimit: 2, roleWindowMs: 60_000, roleQuarantineMs: 1_000 });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100);
    expect(cb.getRoleQuarantine('qa', 200)).not.toBeNull();
    expect(cb.getRoleQuarantine('frontend', 200)).toBeNull();
  });
});

describe('global breaker (read-only mode)', () => {
  it('does not trip below the limit', () => {
    const cb = new CircuitBreakers({ globalLimit: 5, globalWindowMs: 60_000, globalReadOnlyMs: 1_000 });
    for (let i = 0; i < 4; i++) cb.recordIncident(i * 100);
    expect(cb.isReadOnlyMode(500)).toBe(false);
  });

  it('trips at the limit; releases after readOnlyMs', () => {
    const cb = new CircuitBreakers({ globalLimit: 3, globalWindowMs: 60_000, globalReadOnlyMs: 1_000 });
    cb.recordIncident(0);
    cb.recordIncident(100);
    expect(cb.recordIncident(200)).toBe(true);
    expect(cb.isReadOnlyMode(300)).toBe(true);
    // Past readOnlyUntilMs = 200 + 1000 = 1200
    expect(cb.isReadOnlyMode(1_500)).toBe(false);
  });

  it('prunes stale incidents from the window', () => {
    const cb = new CircuitBreakers({ globalLimit: 3, globalWindowMs: 1_000, globalReadOnlyMs: 1_000 });
    cb.recordIncident(0);
    cb.recordIncident(100);
    // 2_000 — first two are stale
    expect(cb.recordIncident(2_000)).toBe(false);
  });

  it('releaseReadOnly exits early', () => {
    const cb = new CircuitBreakers({ globalLimit: 2, globalWindowMs: 60_000, globalReadOnlyMs: 5_000 });
    cb.recordIncident(0);
    cb.recordIncident(100);
    expect(cb.isReadOnlyMode(200)).toBe(true);
    expect(cb.releaseReadOnly()).toBe(true);
    expect(cb.isReadOnlyMode(300)).toBe(false);
  });
});

describe('status snapshot', () => {
  it('reports agents + roles + global state', () => {
    const cb = new CircuitBreakers({
      agentLimit: 2,
      agentWindowMs: 60_000,
      roleLimit: 2,
      roleWindowMs: 60_000,
      roleQuarantineMs: 1_000,
      globalLimit: 2,
      globalWindowMs: 60_000,
      globalReadOnlyMs: 1_000,
    });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 100);
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100);
    cb.recordIncident(0);
    cb.recordIncident(100);

    const s = cb.status(200);
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]).toMatchObject({ agentRunId: 1, recentAttempts: 2, tripped: true });
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0]).toMatchObject({ role: 'qa', recentFailures: 2 });
    expect(s.roles[0]?.quarantinedUntilMs).not.toBeNull();
    expect(s.globalIncidentsInWindow).toBe(2);
    expect(s.readOnlyUntilMs).not.toBeNull();
  });

  it('reports null for expired quarantine + read-only', () => {
    const cb = new CircuitBreakers({
      roleLimit: 2,
      roleWindowMs: 60_000,
      roleQuarantineMs: 100,
      globalLimit: 2,
      globalWindowMs: 60_000,
      globalReadOnlyMs: 100,
    });
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 100); // until 200
    cb.recordIncident(0);
    cb.recordIncident(100); // until 200
    const s = cb.status(1_000); // way past
    expect(s.roles[0]?.quarantinedUntilMs).toBeNull();
    expect(s.readOnlyUntilMs).toBeNull();
  });
});

describe('config', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('defaults match DEFAULT_BREAKER_CONFIG', () => {
    const cb = new CircuitBreakers();
    expect(cb.getConfig()).toEqual(DEFAULT_BREAKER_CONFIG);
  });

  it('partial overrides merge with defaults', () => {
    const cb = new CircuitBreakers({ agentLimit: 99 });
    expect(cb.getConfig().agentLimit).toBe(99);
    expect(cb.getConfig().roleLimit).toBe(DEFAULT_BREAKER_CONFIG.roleLimit);
  });

  it('configFromEnv reads MCP_SUPERVISOR_* vars', () => {
    process.env.MCP_SUPERVISOR_AGENT_BREAKER_LIMIT = '7';
    process.env.MCP_SUPERVISOR_ROLE_QUARANTINE_MS = '12345';
    const c = configFromEnv();
    expect(c.agentLimit).toBe(7);
    expect(c.roleQuarantineMs).toBe(12345);
    expect(c.globalLimit).toBe(DEFAULT_BREAKER_CONFIG.globalLimit);
  });

  it('bad env values fall back to defaults', () => {
    process.env.MCP_SUPERVISOR_AGENT_BREAKER_LIMIT = 'not-a-number';
    process.env.MCP_SUPERVISOR_GLOBAL_BREAKER_LIMIT = '-5';
    const c = configFromEnv();
    expect(c.agentLimit).toBe(DEFAULT_BREAKER_CONFIG.agentLimit);
    expect(c.globalLimit).toBe(DEFAULT_BREAKER_CONFIG.globalLimit);
  });
});

describe('clearAllForTests', () => {
  it('resets all state', () => {
    const cb = new CircuitBreakers({ agentLimit: 2, roleLimit: 2, globalLimit: 2 });
    cb.recordAgentFailure(1, 0);
    cb.recordAgentFailure(1, 1);
    cb.recordRoleFailure('qa', 0);
    cb.recordRoleFailure('qa', 1);
    cb.recordIncident(0);
    cb.recordIncident(1);
    cb.clearAllForTests();
    const s = cb.status(100);
    expect(s.agents).toHaveLength(0);
    expect(s.roles).toHaveLength(0);
    expect(s.globalIncidentsInWindow).toBe(0);
    expect(s.readOnlyUntilMs).toBeNull();
  });
});

/**
 * Module-level store bindings for the ServiceSupervisor + SandboxService
 * transition audit (company B3).
 *
 * Same pattern as `setQaTestRunStore` / `setSandboxServiceEnvStore`:
 * worker_threads don't share module globals, so `company-worker.ts` wires
 * these against ITS OWN better-sqlite3 handle at boot. On the main process
 * nothing calls the setter — consumers must tolerate `null` (they no-op),
 * which also guarantees the supervisor's write path only exists where the
 * supervisor actually runs (the worker).
 *
 * Interfaces are structural slices of the real @mcp/store classes
 * (`CompanySandboxServicesHealth`, `CompanyServiceTransitionsStore`) so
 * tests can hand in plain fakes without touching better-sqlite3/ABI.
 */

export interface ServiceHealthStoreLike {
  updateHealth(
    sessionId: number,
    serviceId: string,
    input: { health: string; healthDetail?: string | null; lastHealthAtMs?: number },
  ): boolean;
  bumpRestartCount(sessionId: number, serviceId: string): number | null;
}

export interface ServiceTransitionsStoreLike {
  record(input: {
    sessionId: number;
    serviceId: string;
    kind: 'status' | 'health';
    fromState?: string | null;
    toState: string;
    reason?: string | null;
    actor: string;
    atMs?: number;
  }): number;
}

/** Structural slice of `CompanyServiceLogsStore` (write + paged read, B4). */
export interface ServiceLogsStoreLike {
  appendAndTrim(
    rows: Array<{
      sessionId: number;
      serviceId: string;
      stream: 'devserver' | 'container' | 'scaffold';
      line: string;
      atMs: number;
    }>,
    cap?: number,
  ): void;
  listPage(
    sessionId: number,
    opts?: {
      serviceId?: string;
      stream?: 'devserver' | 'container' | 'scaffold';
      beforeId?: number;
      limit?: number;
      q?: string;
    },
  ): Array<{ id: number; serviceId: string; stream: string; line: string; atMs: number }>;
}

/**
 * Read slice of `CompanyLocalProjectStore` — the worker-side view of the
 * session's HOST process (B8). The LocalProcessManager singleton lives on
 * the main process only, so the supervisor discovers local processes via
 * this SQLite row (`listBySession` already excludes `destroyed` rows).
 */
export interface LocalProjectReadLike {
  listBySession(sessionId: number): {
    pid: number | null;
    host_port: number;
    status: string;
  } | null;
}

/** Read slice of `CompanySandboxServicesStore` — health columns for tools (B5). */
export interface ServicesReadStoreLike {
  listBySessionAll(sessionId: number): Array<{
    service_id: string;
    health: string;
    health_detail: string | null;
    restart_count: number;
    last_health_at_ms: number | null;
  }>;
}

export interface ServiceSupervisorStores {
  health: ServiceHealthStoreLike;
  transitions: ServiceTransitionsStoreLike;
  /** B4 — ring-buffered structured log sink + reader. Optional: older fakes omit it. */
  logs?: ServiceLogsStoreLike;
  /** B5 — read-only health projection consumed by list_services/service tools. */
  services?: ServicesReadStoreLike;
  /** B8 — session host-process row (probe target discovery). Optional: older fakes omit it. */
  localProjects?: LocalProjectReadLike | null;
}

let stores: ServiceSupervisorStores | null = null;

export function setServiceSupervisorStores(s: ServiceSupervisorStores | null): void {
  stores = s;
}

export function getServiceSupervisorStores(): ServiceSupervisorStores | null {
  return stores;
}

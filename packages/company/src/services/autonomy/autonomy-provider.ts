/**
 * Autonomy layer (C0) — cached per-session provider over `resolveAutonomy`.
 *
 * Thin factory: reads `config_json` through the injected store slice,
 * resolves once and caches. NO timers, NO self-subscription — whoever
 * composes the services (see `orchestrator/wire-services.ts`) connects the
 * `session.config_updated` metaBus event to `invalidate()` via
 * `addBusEventSink`, so a PATCH /config lands on the next `get()`.
 *
 * `env` is injectable for tests; defaults to `process.env` read at each
 * (re)resolve so live env flips behave like today's per-call env reads.
 */
import { resolveAutonomy, type AutonomyConfig } from './autonomy-config.js';

/** Synchronous projection supplied by the owning Company bundle. */
export interface AutonomySessionSource {
  getCompanySession(id: string): { config_json: string | null } | null;
}

export interface AutonomyProvider {
  /** Effective config (cached until `invalidate()`). Never throws. */
  get(): AutonomyConfig;
  /** Drop the cache — next `get()` re-reads `config_json` + env. */
  invalidate(): void;
}

export function createAutonomyProvider(args: {
  sessionSource: AutonomySessionSource;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): AutonomyProvider {
  let cached: AutonomyConfig | null = null;

  return {
    get(): AutonomyConfig {
      if (cached) return cached;
      let configJson: string | null = null;
      try {
        configJson = args.sessionSource.getCompanySession(args.sessionId)?.config_json ?? null;
      } catch (e) {
        // Defensive: a store hiccup must not take autonomy resolution down —
        // fall back to env+defaults (same posture as config-loader.ts).
        console.warn(
          `[autonomy s=${args.sessionId}] config_json read failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      cached = resolveAutonomy(configJson, args.env ?? process.env);
      return cached;
    },
    invalidate(): void {
      cached = null;
    },
  };
}

/**
 * Sticky per-session tool-profile resolution (migration 142).
 *
 * WHY: the tools array is the FIRST segment of the provider prompt-cache
 * prefix (tools → system → messages). Re-running `inferProfileFromHistory`
 * on every resume made the resolved profile depend on whatever tail of the
 * history happened to be loaded (compaction boundaries move, old turns drop
 * out), so the visible tool array flip-flopped between runs of the SAME
 * session — telemetry showed 118 ↔ ~60 tools alternating per round, busting
 * 100% of the cached prefix on turn 1 of every round.
 *
 * CONTRACT: the persisted profile only ever WIDENS (bootstrap < navigate <
 * full). Narrowing across runs is exactly the bug; a tool outside the
 * published catalog is reached through find_tools + code_exec, never by
 * widening mid-run. An explicit narrower override (env/opts) wins
 * for THAT run — diagnostic use — but never clobbers the stored value.
 */
import {
  inferProfileFromHistory,
  inferProfileFromMessage,
  type CoderProfile,
  type ToolTier,
} from './tiers.js';

const PROFILE_RANK: Record<CoderProfile, number> = { bootstrap: 0, navigate: 1, full: 2 };

/** Widen-only merge: the higher-ranked profile wins. */
export function widenProfile(a: CoderProfile, b: CoderProfile): CoderProfile {
  return PROFILE_RANK[b] > PROFILE_RANK[a] ? b : a;
}

export interface PersistedToolsetState {
  profile: CoderProfile | null;
  extraTiers: string[];
  pins: string[];
  visibleCap: number | null;
}

function isCoderProfile(v: unknown): v is CoderProfile {
  return v === 'bootstrap' || v === 'navigate' || v === 'full';
}

/**
 * Parse the mig-142 columns into a typed state. Returns null when the
 * session has never been stamped (legacy session → adopt once and persist).
 * Corrupted JSON degrades to an empty state rather than failing the run.
 */
export function parseToolsetState(
  profileCol: string | null | undefined,
  stateJson: string | null | undefined,
): PersistedToolsetState | null {
  const profile = isCoderProfile(profileCol) ? profileCol : null;
  let extraTiers: string[] = [];
  let pins: string[] = [];
  let visibleCap: number | null = null;
  if (stateJson) {
    try {
      const parsed = JSON.parse(stateJson) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.extraTiers)) {
          extraTiers = parsed.extraTiers.filter((t): t is string => typeof t === 'string');
        }
        if (Array.isArray(parsed.pins)) {
          pins = parsed.pins.filter((p): p is string => typeof p === 'string');
        }
        if (typeof parsed.visibleCap === 'number' && parsed.visibleCap > 0) {
          visibleCap = parsed.visibleCap;
        }
      }
    } catch { /* corrupted column — treat as empty */ }
  }
  if (profile == null && stateJson == null) return null;
  return { profile, extraTiers, pins, visibleCap };
}

export interface ResolveSessionProfileArgs {
  /** `opts.profile ?? CODER_PROFILE env ?? agentDef.profile` — wins outright. */
  explicitProfile?: CoderProfile | 'auto';
  hasHistory: boolean;
  /** tool_use names seen in the LOADED history (tail — inherently unstable). */
  historyToolNames: readonly string[];
  /** Mig-142 state, or null for never-stamped sessions. */
  persisted: PersistedToolsetState | null;
  /** Preflight seed profile (fresh sessions only). */
  preflightProfile?: CoderProfile;
  /** First user message — feeds the 'auto' keyword heuristic. */
  userMessage?: string;
  /** Runtime tier map for external MCP tools. */
  tierOverrides?: ReadonlyMap<string, ToolTier>;
  /** CODER_STICKY_PROFILE !== '0'. OFF reproduces the legacy per-run inference. */
  stickyEnabled: boolean;
}

export interface ResolvedSessionProfile {
  profile: CoderProfile;
  /** Non-null → caller persists this value (widen-only setter). */
  persistAs: CoderProfile | null;
  source:
    | 'explicit'
    | 'persisted'
    | 'persisted-widened'
    | 'history-adopted'
    | 'preflight'
    | 'heuristic'
    | 'default';
}

/** Resolve the run's profile and what (if anything) to persist. Pure. */
export function resolveSessionProfile(args: ResolveSessionProfileArgs): ResolvedSessionProfile {
  const inferredFromHistory = (): CoderProfile =>
    inferProfileFromHistory(args.historyToolNames, args.tierOverrides);

  // 1. Explicit always wins for the run. 'auto' resolves through the
  //    preflight seed, then the message keyword heuristic (legacy order).
  if (args.explicitProfile != null) {
    const resolved: CoderProfile = args.explicitProfile === 'auto'
      ? (args.preflightProfile ?? inferProfileFromMessage(args.userMessage ?? ''))
      : args.explicitProfile;
    if (!args.stickyEnabled) return { profile: resolved, persistAs: null, source: 'explicit' };
    // Widen-only persistence: stamp unstamped sessions; widen stamped ones;
    // a narrower explicit value applies to this run only.
    const stored = args.persisted?.profile ?? null;
    const persistAs = stored == null
      ? resolved
      : (PROFILE_RANK[resolved] > PROFILE_RANK[stored] ? resolved : null);
    return { profile: resolved, persistAs, source: 'explicit' };
  }

  // Sticky OFF → exact legacy behavior (kill-switch escape hatch).
  if (!args.stickyEnabled) {
    const legacy = args.hasHistory
      ? inferredFromHistory()
      : (args.preflightProfile ?? 'bootstrap');
    return { profile: legacy, persistAs: null, source: args.hasHistory ? 'heuristic' : 'default' };
  }

  // 2. Stamped session: reuse, widening if the loaded history demonstrably
  //    used a higher tier (e.g. a prior run's persist failed). NEVER narrow —
  //    a tail that only shows bootstrap calls is exactly the instability this
  //    module exists to ignore.
  const stored = args.persisted?.profile ?? null;
  if (stored != null) {
    const widened = args.hasHistory ? widenProfile(stored, inferredFromHistory()) : stored;
    return widened === stored
      ? { profile: stored, persistAs: null, source: 'persisted' }
      : { profile: widened, persistAs: widened, source: 'persisted-widened' };
  }

  // 3. Legacy resumed session (pre-mig-142): infer ONCE and adopt.
  if (args.hasHistory) {
    const adopted = inferredFromHistory();
    return { profile: adopted, persistAs: adopted, source: 'history-adopted' };
  }

  // 4. Fresh session: preflight seed or the bootstrap default — stamped at
  //    creation so every later resume starts from the same floor.
  const fresh = args.preflightProfile ?? 'bootstrap';
  return { profile: fresh, persistAs: fresh, source: args.preflightProfile ? 'preflight' : 'default' };
}

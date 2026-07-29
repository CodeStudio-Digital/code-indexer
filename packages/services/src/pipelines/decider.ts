/**
 * Decider — runtime feature-flag plumbing for the candidate-pipeline framework.
 *
 * Inspired by `PipelineQuery.params()` / `decider()` in
 * `candidate-pipeline/candidate_pipeline.rs:59-62` (xai-org/x-algorithm).
 *
 * Every pipeline stage consults a `Decider` to decide whether it should run
 * for a given query. Stages keep their `enable(query)` check trivial; the
 * gating logic lives here.
 *
 * Three concrete deciders, plus a `CompositeDecider` that chains them:
 *   1. `ConfigJsonDecider` — reads `config_json.pipelines.<flag>` per session.
 *   2. `EnvVarDecider`     — reads `MCP_PIPELINES_<FLAG>` from process env.
 *   3. `ConstantDecider`   — hardcoded for tests / explicit overrides.
 *
 * Lookup order in `CompositeDecider`: session config → env var → fallback.
 * The first non-undefined answer wins.
 */

export interface DeciderContext {
  sessionId?: string;
  companySessionId?: string;
  templateId?: number;
  userId?: string;
  /** Caller-supplied snapshot of the resolved `config_json` for the session. */
  sessionConfig?: Record<string, unknown> | null;
}

export interface Decider {
  /** Returns true if the flag is enabled for this context. Undefined → unknown. */
  isEnabled(flag: string, ctx?: DeciderContext): boolean | undefined;
  /** Reads a typed value. Undefined → unknown (caller falls back). */
  getValue<T = unknown>(flag: string, ctx?: DeciderContext): T | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// ConfigJsonDecider
// Reads from the session's `config_json.pipelines.<flag>` slot. Falls back to
// `config_json.pipelines.<flag>.enabled` for object-valued flags.
// ─────────────────────────────────────────────────────────────────────────

export class ConfigJsonDecider implements Decider {
  isEnabled(flag: string, ctx?: DeciderContext): boolean | undefined {
    const value = this.getValue(flag, ctx);
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object' && value !== null && 'enabled' in value) {
      const enabled = (value as { enabled?: unknown }).enabled;
      return typeof enabled === 'boolean' ? enabled : undefined;
    }
    return undefined;
  }

  getValue<T = unknown>(flag: string, ctx?: DeciderContext): T | undefined {
    const pipelines = (ctx?.sessionConfig?.pipelines ?? null) as Record<string, unknown> | null;
    if (!pipelines || typeof pipelines !== 'object') return undefined;
    if (!(flag in pipelines)) return undefined;
    return pipelines[flag] as T;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EnvVarDecider
// Reads `MCP_PIPELINES_<UPPER_SNAKE>` from env. Truthiness rules:
//   - 'true' / '1' / 'on' / 'yes' → true
//   - 'false' / '0' / 'off' / 'no' → false
//   - JSON-shaped (`{...}` or `[...]`) → parsed object
//   - anything else → string
// ─────────────────────────────────────────────────────────────────────────

export class EnvVarDecider implements Decider {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  private envKey(flag: string): string {
    return `MCP_PIPELINES_${flag.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  }

  isEnabled(flag: string): boolean | undefined {
    const raw = this.env[this.envKey(flag)];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim().toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(trimmed))  return true;
    if (['false', '0', 'off', 'no'].includes(trimmed)) return false;
    return undefined;
  }

  getValue<T = unknown>(flag: string): T | undefined {
    const raw = this.env[this.envKey(flag)];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed) as T; } catch { return undefined; }
    }
    // boolean coercion convenience
    const lower = trimmed.toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(lower))   return true  as unknown as T;
    if (['false', '0', 'off', 'no'].includes(lower))  return false as unknown as T;
    return trimmed as unknown as T;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ConstantDecider — used by tests and explicit overrides.
// ─────────────────────────────────────────────────────────────────────────

export class ConstantDecider implements Decider {
  constructor(private flags: Record<string, unknown> = {}) {}

  isEnabled(flag: string): boolean | undefined {
    const v = this.flags[flag];
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'object' && v !== null && 'enabled' in v) {
      const enabled = (v as { enabled?: unknown }).enabled;
      return typeof enabled === 'boolean' ? enabled : undefined;
    }
    return undefined;
  }

  getValue<T = unknown>(flag: string): T | undefined {
    return this.flags[flag] as T | undefined;
  }

  set(flag: string, value: unknown): void { this.flags[flag] = value; }
}

// ─────────────────────────────────────────────────────────────────────────
// CompositeDecider — first non-undefined wins.
// ─────────────────────────────────────────────────────────────────────────

export class CompositeDecider implements Decider {
  constructor(private deciders: Decider[]) {}

  isEnabled(flag: string, ctx?: DeciderContext): boolean | undefined {
    for (const d of this.deciders) {
      const v = d.isEnabled(flag, ctx);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  getValue<T = unknown>(flag: string, ctx?: DeciderContext): T | undefined {
    for (const d of this.deciders) {
      const v = d.getValue<T>(flag, ctx);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

/**
 * Convenience factory: session config has the highest priority, then env
 * vars, then constant defaults. Matches the precedence described in the
 * refactor plan ("session → template → global → fallback").
 */
export function defaultDecider(
  opts: { defaults?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {},
): CompositeDecider {
  return new CompositeDecider([
    new ConfigJsonDecider(),
    new EnvVarDecider(opts.env),
    new ConstantDecider(opts.defaults ?? {}),
  ]);
}

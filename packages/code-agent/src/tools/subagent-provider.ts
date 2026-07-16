/**
 * Per-profile subagent provider resolution.
 *
 * The admin "Subagent provider/model" config has a single default plus
 * optional per-profile overrides (implement vs explore vs verify vs review vs
 * full). This module turns those snapshotted targets into `ChatProvider`s,
 * lazily and memoized by `providerId:model` so a batch of N same-profile
 * agents only builds one provider.
 *
 * `createProvider` is injected (rather than importing `@mcp/services`) to keep
 * this module decoupled and unit-testable.
 */
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type {
  MicroAgentProfile,
  MicroAgentProfileId,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';

/** A resolved subagent target, or `null` to inherit the parent provider. */
export interface SubagentTarget {
  providerId: string;
  modelId: string | null;
}

export interface SubagentProviderResolverOpts {
  /** Parent session provider id — a target equal to it (no model) inherits the parent. */
  sessionProvider: string;
  /** Parent session model — a target model equal to it also inherits the parent. */
  sessionModel: string | undefined;
  /** Default subagent target (single control), used when a profile has no entry. */
  defaultTarget: SubagentTarget | null;
  /** Per-profile targets, already merged with the default by the store. */
  profileTargets: ReadonlyMap<MicroAgentProfileId, SubagentTarget | null>;
  /** Default reasoning-effort override; used when a profile has no effort entry. */
  defaultEffort: string | null;
  /** Per-profile reasoning-effort overrides, already merged with the default by the store. */
  profileEfforts: ReadonlyMap<MicroAgentProfileId, string | null>;
  /** Injected factory (createCoderProvider) — decouples this module from @mcp/services. */
  createProvider: (providerId: string, model?: string) => Promise<ChatProvider>;
}

export interface SubagentProviderResolver {
  /** Provider for a profile; `undefined` means "use the parent provider". */
  forProfile(profileId?: string): Promise<ChatProvider | undefined>;
  /** Reasoning-effort for a profile; `undefined` means "inherit the parent session effort". */
  effortFor(profileId?: string): string | undefined;
}

export function createSubagentProviderResolver(
  opts: SubagentProviderResolverOpts,
): SubagentProviderResolver {
  const cache = new Map<string, Promise<ChatProvider>>();

  const build = (target: SubagentTarget | null): Promise<ChatProvider> | undefined => {
    if (!target) return undefined;
    const model = target.modelId ?? undefined;
    const differs =
      target.providerId !== opts.sessionProvider ||
      (!!model && model !== opts.sessionModel);
    if (!differs) return undefined; // resolves to the parent — no separate provider
    const key = `${target.providerId}:${model ?? ''}`;
    let p = cache.get(key);
    if (!p) {
      p = opts.createProvider(target.providerId, model);
      cache.set(key, p);
    }
    return p;
  };

  return {
    forProfile(profileId) {
      const key = profileId as MicroAgentProfileId | undefined;
      const target =
        key && opts.profileTargets.has(key)
          ? opts.profileTargets.get(key) ?? null
          : opts.defaultTarget;
      return Promise.resolve(build(target));
    },
    effortFor(profileId) {
      const key = profileId as MicroAgentProfileId | undefined;
      const effort =
        key && opts.profileEfforts.has(key)
          ? opts.profileEfforts.get(key) ?? null
          : opts.defaultEffort;
      return effort ?? undefined;
    },
  };
}

/**
 * Call-site helper: the single place that answers "which provider does THIS
 * subagent use". Falls back to the default `subagentProvider` (or the parent)
 * when no per-profile resolver is wired, preserving legacy behavior.
 */
export async function providerForProfile(
  deps: SubagentDeps,
  profile?: MicroAgentProfile | string,
): Promise<ChatProvider> {
  const id = typeof profile === 'string' ? profile : profile?.id;
  if (deps.resolveProviderForProfile) {
    const p = await deps.resolveProviderForProfile(id);
    if (p) return p;
  }
  return deps.subagentProvider ?? deps.provider;
}

/**
 * Reasoning effort for a subagent of the given profile. `undefined` means the
 * subagent inherits the parent session's effort (the legacy behavior).
 */
export function effortForProfile(
  deps: SubagentDeps,
  profile?: MicroAgentProfile | string,
): string | undefined {
  const id = typeof profile === 'string' ? profile : profile?.id;
  return deps.resolveEffortForProfile?.(id);
}

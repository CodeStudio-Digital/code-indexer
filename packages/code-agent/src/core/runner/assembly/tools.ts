/**
 * Per-turn tool list assembly. Extracted from the legacy `buildTools` /
 * `buildToolsCacheKey` closures in runner.ts so the BT's `Executing` node
 * can call this directly. Behavior is byte-identical to the legacy
 * closures — see `runner.ts` for the original implementation.
 *
 * Invariants:
 *   - Always returns alphabetically sorted by name (stable for prompt cache).
 *   - "Essential" company tools survive `maxTools` truncation; the truncation
 *     only eats the tail of the non-essential bucket.
 *   - Bootstrap-only profile shortens descriptions to their first sentence.
 */
import { createHash } from 'node:crypto';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import { filterByTiers, getToolTier } from '@mcp/code-agent/tools/tiers.js';
import {
  NEVER_TRIM,
  PREVIEW_WORKFLOW_FLOOR,
  ROLE_CAPABILITY_FLOOR,
  selectUnderCap,
} from '@mcp/code-agent/tools/tool-priority.js';
import { terseDescription } from '@mcp/code-agent/tools/descriptions.js';
import { getModelMaxTools } from '@mcp/code-agent/providers/capabilities.js';
import { runToolFilterHook } from '@mcp/code-agent/core/hooks.js';
import { isEssentialCompanyTool } from '../company-essentials.js';

export interface SerializedTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface BuildToolsArgs {
  registry: ToolRegistry;
  globalDisabledTools?: ReadonlySet<string>;
  sessionDisabledTools?: ReadonlySet<string>;
  externalToolTiers?: ReadonlyMap<string, ToolTier>;
  /** Null disables tier filtering (subagents, tests). */
  activeTiers: Set<ToolTier> | null;
  /**
   * Hidden tools the model called by name (dispatch pinned them). Bypass
   * ONLY the tier filter and the model cap — disabled filters, the
   * tool-filter hook still applies every turn.
   */
  pinnedTools?: ReadonlySet<string>;
  /** Explicit agent/host pins. Unlike runtime promotions, these are permanent. */
  requiredPinnedTools?: ReadonlySet<string>;
  /**
   * Session-level visible-tool ceiling (task preflight). Effective cap is
   * `min(model cap, sessionToolCap)`. Terse-description behavior stays tied
   * to the MODEL cap — a seeded session on a large model keeps full text.
   */
  sessionToolCap?: number;
  /**
   * P5a — run-constant description format decided at the run's first build
   * (see RunContext.terseDescriptionsLock). When set, overrides the live
   * per-turn `bootstrapOnly` computation so a mid-run tier promotion never
   * rewrites existing descriptions terse→full (whole-prefix cache bust).
   * Undefined preserves the live computation (subagents/tests).
   */
  terseDescriptionsLock?: boolean;
  toolContext: ToolContext;
  provider: ChatProvider;
  /** Non-tool capabilities (currently skills) in the immutable attempt set. */
  catalogOnlyCapabilities?: readonly CoderTool[];
}

/** Trim stats for the turn — null when the model cap didn't fire. */
export interface BuildToolsCapInfo {
  /** Tool count before the cap. */
  total: number;
  /** The model's maxTools cap. */
  cap: number;
  /** How many tools were dropped. */
  dropped: number;
}

export interface BuildToolsResult {
  tools: SerializedTool[];
  capInfo: BuildToolsCapInfo | null;
  /** Actual serialized size of the eligible pre-cap catalog this turn. */
  eligibleToolsDefChars: number;
  /** Names the downstream relevance selector must never remove. */
  protectedToolNames: ReadonlySet<string>;
  /** Authorized post-policy/pre-cap tools used to derive every projection. */
  authorizedTools: readonly CoderTool[];
}

const BUILD_TASK_LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    gate: {
      type: 'string',
      enum: ['track'],
      description: "'track' = lightweight progress checklist; never pauses.",
    },
    items: {
      type: 'array',
      description:
        'Full checklist. Each item: {id?, content, activeForm, status: pending|in_progress|completed}.',
      items: { type: 'object' },
    },
    updates: {
      type: 'array',
      description:
        'Patch existing checklist items by id. Each entry: {id, status?, content?, activeForm?}.',
      items: { type: 'object' },
    },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

export function buildTools(args: BuildToolsArgs): BuildToolsResult {
  let filtered = args.registry.list();
  // submit_plan is an execution gate, not a generic planning aid. Advertising
  // it to Build agents lets weak models turn a pre-approved implementation
  // request into an indefinite human wait. Keep the handler in the registry
  // for persisted calls, but expose it only when Plan mode owns that gate.
  const specModeBlocksPlan = args.toolContext.runner?.specMode === true;
  const planModeAllowsPlan = args.toolContext.runner?.planMode === true
    && !specModeBlocksPlan;
  if (!planModeAllowsPlan) {
    filtered = filtered.filter((tool) => tool.name !== 'submit_plan');
  }

  if (args.globalDisabledTools?.size) {
    filtered = filtered.filter((t) => !args.globalDisabledTools!.has(t.name));
  }
  if (args.sessionDisabledTools?.size) {
    filtered = filtered.filter((t) => !args.sessionDisabledTools!.has(t.name));
  }

  filtered = args.activeTiers
    ? filterByTiers(filtered, args.activeTiers, args.externalToolTiers)
    : filtered;

  // Pins: union past the tier filter. Re-pulled from the registry (the
  // tier filter dropped them from `filtered`) with the disabled filters
  // re-applied — a disabled tool can never re-enter via a pin. The hook
  // and filtering below still see (and may re-drop) pins.
  if (args.pinnedTools?.size) {
    const present = new Set(filtered.map((t) => t.name));
    for (const t of args.registry.list()) {
      if (!args.pinnedTools.has(t.name) || present.has(t.name)) continue;
      if (!planModeAllowsPlan && t.name === 'submit_plan') continue;
      if (args.globalDisabledTools?.has(t.name)) continue;
      if (args.sessionDisabledTools?.has(t.name)) continue;
      filtered.push(t);
    }
  }

  const hookAllow = runToolFilterHook(
    args.toolContext.cwd,
    filtered.map((t) => ({ name: t.name, source: t.source })),
    {
      projectName: args.toolContext.projectName,
      providerName: args.provider.name,
      model: args.provider.model,
      profile: args.activeTiers ? Array.from(args.activeTiers).sort().join(',') : undefined,
    },
  );
  if (hookAllow && hookAllow.size > 0) {
    const before = filtered.length;
    filtered = filtered.filter((t) => hookAllow.has(t.name));
    if (filtered.length < before) {
      console.log(`[coder] tool-filter hook removed ${before - filtered.length} tool(s)`);
    }
  }

  const eligibleBeforeCap = [...filtered];

  // Protection partition BEFORE truncation. Required/configured pins are a
  // permanent floor. Runtime-discovered pins form a bounded LRU working set:
  // they bypass tier filtering, but only the newest ones consume remaining
  // cap slots and displace low-priority ordinary tools.
  const isMasterRunner = !!args.toolContext.companyContext?.isMaster;
  const isCompanyRunner = !!args.toolContext.companyContext;
  const hardProtectedBucket: typeof filtered = [];
  const dynamicPinnedByName = new Map<string, typeof filtered[number]>();
  const others: typeof filtered = [];
  for (const t of filtered) {
    const isHardProtected =
      NEVER_TRIM.has(t.name) ||
      (specModeBlocksPlan && t.name === 'submit_spec') ||
      PREVIEW_WORKFLOW_FLOOR.has(t.name) ||
      ROLE_CAPABILITY_FLOOR.has(t.name) ||
      !!args.requiredPinnedTools?.has(t.name) ||
      (isCompanyRunner && isEssentialCompanyTool(t.name, isMasterRunner));
    if (isHardProtected) hardProtectedBucket.push(t);
    else if (args.pinnedTools?.has(t.name)) dynamicPinnedByName.set(t.name, t);
    else others.push(t);
  }
  const hardLimit = args.provider.toolLimits?.maxCount;
  if (hardLimit !== undefined && (!Number.isSafeInteger(hardLimit) || hardLimit < 1)) throw new Error('Invalid verified provider tool limit');
  const modelMaxTools = Math.min(getModelMaxTools(args.provider.model ?? ''), hardLimit ?? Infinity);
  // Perf W3 — default session ceiling. `getModelMaxTools` falls back to 200
  // for models missing from the registry, and sessions without a preflight
  // cap shipped the whole catalog (telemetry: 1319 turns >96 visible tools,
  // ~105k chars ≈ 26k tokens of defs per turn, constant 128-tool sessions).
  // A 28-tool default keeps the high-priority working set while relying on
  // find_tools/pinning for cold capabilities. The default is run-constant,
  // so membership only changes across runs —
  // never mid-run — which preserves the prompt-cache contract. Pins and the
  // protected floor still survive the cap. Applies only to
  // tier-managed sessions: `activeTiers === null` (subagents/tests) relies
  // on the full registry being exposed — see the invariant on BuildToolsArgs.
  const defaultSessionCap = 28;
  const sessionCap = args.sessionToolCap != null && args.sessionToolCap > 0
    ? args.sessionToolCap
    : args.activeTiers !== null
      ? defaultSessionCap
      : 0;
  const maxTools = sessionCap > 0 ? Math.min(modelMaxTools, sessionCap) : modelMaxTools;
  const dynamicPinnedNewestFirst = [...(args.pinnedTools ?? [])]
    .reverse()
    .map((name) => dynamicPinnedByName.get(name))
    .filter((tool): tool is typeof filtered[number] => tool !== undefined);
  const totalBefore = hardProtectedBucket.length + dynamicPinnedByName.size + others.length;
  if (hardLimit !== undefined && hardProtectedBucket.length > hardLimit) {
    throw new Error(`Tool projection cannot fit required capabilities: ${hardProtectedBucket.length} required, verified provider limit ${hardLimit}. Adjust the model or required tool configuration.`);
  }
  let protectedBucket: typeof filtered = hardProtectedBucket;
  let capInfo: BuildToolsCapInfo | null = null;
  if (totalBefore > maxTools) {
    const dynamicRoom = Math.max(0, maxTools - hardProtectedBucket.length);
    const keptDynamicPins = dynamicPinnedNewestFirst.slice(0, dynamicRoom);
    protectedBucket = [...hardProtectedBucket, ...keptDynamicPins];
    const room = Math.max(0, maxTools - protectedBucket.length);
    const selection = selectUnderCap(others, room, (name) =>
      getToolTier(name, args.externalToolTiers));
    const keptOthers = selection.kept;
    const cutNames = selection.dropped;
    const droppedDynamicPins = dynamicPinnedNewestFirst.slice(keptDynamicPins.length);
    filtered = [...protectedBucket, ...keptOthers];
    capInfo = {
      total: totalBefore,
      cap: maxTools,
      dropped: cutNames.length + droppedDynamicPins.length,
    };
    // Soft-cap: the protected set is never dropped even when it alone
    // exceeds the cap (e.g. company master on a 32-tool model).
    const overflow = protectedBucket.length > maxTools
      ? ` — protected set alone exceeds the cap, kept all ${protectedBucket.length}`
      : '';
    const capSource = maxTools >= modelMaxTools
      ? 'model limit'
      : args.sessionToolCap != null && args.sessionToolCap > 0
        ? 'session preflight cap'
        : 'default session cap';
    console.log(
      `[coder] tool cap: ${totalBefore} → ${filtered.length} (${capSource} ${maxTools} for ${args.provider.model}, strategy=priority) — ` +
        `${hardProtectedBucket.length} hard protected, ${keptDynamicPins.length}/${dynamicPinnedByName.size} dynamic pins kept, ` +
        `${keptOthers.length}/${others.length} others kept, ${capInfo.dropped} dropped${overflow}. ` +
        `Dropped: ${[...droppedDynamicPins.map((tool) => tool.name), ...cutNames].slice(0, 20).join(', ')}` +
        `${capInfo.dropped > 20 ? `, … (+${capInfo.dropped - 20})` : ''}`,
    );
  } else {
    protectedBucket = [...hardProtectedBucket, ...dynamicPinnedNewestFirst];
    filtered = [...protectedBucket, ...others];
  }
  // Presentation invariant: globally alphabetical, byte-stable for the
  // prompt cache. Selection above is priority-ordered; this is display.
  // (Historically company essentials were emitted as a separate sorted
  // segment before the others — the global sort supersedes that, matching
  // the documented invariant at the top of this file.)
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  // Bootstrap-only profile aggressively shortens descriptions. Bootstrap is
  // the most expensive turn (no cache warmth yet) and the agent only needs
  // to know WHICH tool routes WHERE — full USE/DON'T text becomes useful
  // only after promotion to navigate/admin.
  // P5a: when the caller passes the run-constant lock, honor it — the live
  // computation flips terse→full on the first promotion and rewrites every
  // surviving description (measured: whole tools-prefix re-cache).
  const bootstrapOnly = args.terseDescriptionsLock ?? (
    !!args.activeTiers
    && !args.activeTiers.has('navigate')
    && !args.activeTiers.has('admin')
  );
  // Compact catalogs (EFFECTIVE cap ≤ 64) get terse descriptions in EVERY
  // tier state: serialized bytes compete with task context, while find_tools
  // returns the full contract on demand. Safety and lifecycle policy belong
  // in runtime gates, not repeated prose on every tool. Run-constant inputs
  // keep this byte-stable within a run.
  const compactModel = maxTools <= 64;
  const useTerse = (): boolean => bootstrapOnly || compactModel;
  const serializeTool = (t: typeof filtered[number]): SerializedTool => {
    if (!planModeAllowsPlan && t.name === 'task_list') {
      return {
        name: t.name,
        description: 'Maintain the live progress checklist without pausing execution.',
        parameters: BUILD_TASK_LIST_SCHEMA,
      };
    }
    return {
      name: t.name,
      description: useTerse() ? terseDescription(t.description) : t.description,
      parameters: t.parameters,
    };
  };

  const tools: SerializedTool[] = filtered.map(serializeTool);
  const eligibleToolsDefChars = JSON.stringify(
    eligibleBeforeCap
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(serializeTool),
  ).length;

  return {
    tools,
    capInfo,
    eligibleToolsDefChars,
    protectedToolNames: new Set(protectedBucket.map((tool) => tool.name)),
    authorizedTools: [
      ...eligibleBeforeCap,
      ...(args.catalogOnlyCapabilities ?? []),
    ],
  };
}

export interface BuildToolsCacheKeyArgs {
  activeTiers: Set<ToolTier> | null;
  pinnedTools?: ReadonlySet<string>;
  requiredPinnedTools?: ReadonlySet<string>;
}

/**
 * Cache key driving `buildTools` re-runs.
 * Pins contribute their sorted names: a promotion/eviction swap = a new key
 * (one rebuild, then stable). LRU touches alone do not change membership.
 */
export function buildToolsCacheKey(args: BuildToolsCacheKeyArgs): string {
  const tierKey = args.activeTiers ? Array.from(args.activeTiers).sort().join(',') : '*';
  const pinKey = args.pinnedTools?.size ? Array.from(args.pinnedTools).sort().join(',') : '';
  const requiredKey = args.requiredPinnedTools?.size
    ? Array.from(args.requiredPinnedTools).sort().join(',')
    : '';
  return `${tierKey}|pins=${pinKey}|required=${requiredKey}`;
}

/**
 * Stable sha1 fingerprint of the serialized tool list. Used by
 * `SessionStore.recordSessionInput` to dedup turn-start snapshots — same
 * fingerprint = no new DB row, tier promotion = new row.
 */
export function fingerprintTools(tools: SerializedTool[]): string {
  return createHash('sha1').update(JSON.stringify(tools)).digest('hex');
}

/**
 * Same fingerprint, but over an already-serialized tools array — callers
 * that stringify for size metrics (`tools_def_chars`) reuse the JSON
 * instead of paying a second stringify.
 */
export function fingerprintToolsJson(toolsJson: string): string {
  return createHash('sha1').update(toolsJson).digest('hex');
}

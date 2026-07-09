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
import type { ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import { filterByTiers, getToolTier } from '@mcp/code-agent/tools/tiers.js';
import { NEVER_TRIM, selectUnderCap } from '@mcp/code-agent/tools/tool-priority.js';
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
   * tool-filter hook and the goal-gate still apply every turn.
   */
  pinnedTools?: ReadonlySet<string>;
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
}

export function buildTools(args: BuildToolsArgs): BuildToolsResult {
  let filtered = args.registry.list();

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
  // and goal-gate below still see (and may re-drop) pinned tools.
  if (args.pinnedTools?.size) {
    const present = new Set(filtered.map((t) => t.name));
    for (const t of args.registry.list()) {
      if (!args.pinnedTools.has(t.name) || present.has(t.name)) continue;
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

  // NOTE: `create_goal` stays in the tool surface for the ENTIRE run — we
  // deliberately do NOT remove it once a goal is in_progress. Tool-array
  // membership is the first segment of the provider prompt-cache prefix;
  // dropping a tool mid-run changes the serialized bytes and invalidates the
  // whole prefix (measured: a full ~50–80k-token re-write on the turn after
  // the goal is created, every round). The create_goal loop guard
  // (sessions 656/658) now lives entirely in the handler: `bumpCreateBurst`
  // hard-refuses bursts, and a redundant call while a goal is in_progress is
  // rejected (not superseded). See `packages/code-agent/src/tools/goal.ts`.

  // Protection partition BEFORE truncation: company orchestration tools
  // (master / subordinate) and the session-class-agnostic NEVER_TRIM floor
  // (discovery core, minimal reads, interaction/lifecycle) must NEVER be
  // sliced by maxTools.
  const isMasterRunner = !!args.toolContext.companyContext?.isMaster;
  const isCompanyRunner = !!args.toolContext.companyContext;
  const protectedBucket: typeof filtered = [];
  const others: typeof filtered = [];
  for (const t of filtered) {
    const isProtected =
      NEVER_TRIM.has(t.name) ||
      !!args.pinnedTools?.has(t.name) ||
      (isCompanyRunner && isEssentialCompanyTool(t.name, isMasterRunner));
    (isProtected ? protectedBucket : others).push(t);
  }
  const modelMaxTools = getModelMaxTools(args.provider.model ?? '');
  const maxTools = args.sessionToolCap != null && args.sessionToolCap > 0
    ? Math.min(modelMaxTools, args.sessionToolCap)
    : modelMaxTools;
  const totalBefore = protectedBucket.length + others.length;
  let capInfo: BuildToolsCapInfo | null = null;
  if (totalBefore > maxTools) {
    const room = Math.max(0, maxTools - protectedBucket.length);
    const legacy = process.env.CODER_PRIORITY_TRIM_DISABLE === '1';
    let keptOthers: typeof filtered;
    let cutNames: string[];
    if (legacy) {
      // Kill switch — the historical alphabetical tail-cut.
      const sorted = [...others].sort((a, b) => a.name.localeCompare(b.name));
      keptOthers = sorted.slice(0, room);
      cutNames = sorted.slice(room).map((t) => t.name);
    } else {
      const sel = selectUnderCap(others, room, (n) => getToolTier(n, args.externalToolTiers));
      keptOthers = sel.kept;
      cutNames = sel.dropped;
    }
    filtered = [...protectedBucket, ...keptOthers];
    capInfo = { total: totalBefore, cap: maxTools, dropped: cutNames.length };
    // Soft-cap: the protected set is never dropped even when it alone
    // exceeds the cap (e.g. company master on a 32-tool model).
    const overflow = protectedBucket.length > maxTools
      ? ` — protected set alone exceeds the cap, kept all ${protectedBucket.length}`
      : '';
    const capSource = maxTools < modelMaxTools ? 'session preflight cap' : 'model limit';
    console.log(
      `[coder] tool cap: ${totalBefore} → ${filtered.length} (${capSource} ${maxTools} for ${args.provider.model}, strategy=${legacy ? 'legacy' : 'priority'}) — ` +
        `${protectedBucket.length} protected kept, ${keptOthers.length}/${others.length} others kept, ${cutNames.length} dropped${overflow}. ` +
        `Dropped: ${cutNames.slice(0, 20).join(', ')}${cutNames.length > 20 ? `, … (+${cutNames.length - 20})` : ''}`,
    );
  } else {
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
  // Compact-catalog models (cap ≤ 64 — GLM flash class) get terse
  // descriptions in EVERY tier state: serialized bytes compete with real
  // context on a small model, and full text is recoverable via find_tools.
  // Exception: the NEVER_TRIM core keeps its full USE/DON'T text — those
  // are the tools whose discipline notes matter most. Deliberately keyed
  // to the MODEL cap, not the session preflight cap.
  const compactModel = modelMaxTools <= 64;
  const useTerse = (name: string): boolean =>
    (bootstrapOnly || compactModel) && !(compactModel && NEVER_TRIM.has(name));

  const tools: SerializedTool[] = filtered.map((t) => ({
    name: t.name,
    description: useTerse(t.name) ? terseDescription(t.description) : t.description,
    parameters: t.parameters,
  }));

  return { tools, capInfo };
}

export interface BuildToolsCacheKeyArgs {
  activeTiers: Set<ToolTier> | null;
  pinnedTools?: ReadonlySet<string>;
}

/**
 * Cache key driving `buildTools` re-runs. Goal status is intentionally NOT
 * part of the key: `create_goal` now stays visible for the whole run, so the
 * tool membership no longer depends on goal lifecycle. Keeping the key
 * goal-independent keeps the provider prompt-cache prefix byte-stable.
 * Pins contribute their sorted names: a new pin = a new key (one rebuild,
 * then stable).
 */
export function buildToolsCacheKey(args: BuildToolsCacheKeyArgs): string {
  const tierKey = args.activeTiers ? Array.from(args.activeTiers).sort().join(',') : '*';
  const pinKey = args.pinnedTools?.size ? Array.from(args.pinnedTools).sort().join(',') : '';
  return `${tierKey}|pins=${pinKey}`;
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

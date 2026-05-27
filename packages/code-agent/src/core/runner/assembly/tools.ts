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
import { filterByTiers } from '@mcp/code-agent/tools/tiers.js';
import { terseDescription } from '@mcp/code-agent/tools/descriptions.js';
import { getModelMaxTools } from '@mcp/code-agent/providers/capabilities.js';
import { runToolFilterHook } from '@mcp/code-agent/core/hooks.js';
import { isEssentialCompanyTool } from '../company-essentials.js';
import { filterGoalToolsByState } from '../pure-helpers.js';

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
  toolContext: ToolContext;
  provider: ChatProvider;
  /** Caller-owned flag — true if a goal-hidden log already fired this run. */
  goalToolAlreadyLogged: boolean;
}

export interface BuildToolsResult {
  tools: SerializedTool[];
  /**
   * New value for the runner's `goalToolHiddenLogged` flag. Caller MUST
   * persist this so the once-per-session log discipline survives.
   */
  goalToolHiddenLogged: boolean;
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

  // Hide `create_goal` when an in-progress goal exists. Eliminates the loop
  // seen in sessions 656/658 where the model kept calling create_goal
  // instead of executing real work. Read fresh each turn — `update_goal`
  // flipping status to 'complete' re-exposes the tool automatically.
  let goalToolHiddenLogged = args.goalToolAlreadyLogged;
  const activeGoal = args.toolContext.getGoalState?.();
  if (activeGoal && activeGoal.status === 'in_progress') {
    const before = filtered.length;
    filtered = filterGoalToolsByState(filtered, activeGoal);
    if (filtered.length < before && !goalToolHiddenLogged) {
      goalToolHiddenLogged = true;
      const preview = activeGoal.text.length > 80
        ? `${activeGoal.text.slice(0, 80)}…`
        : activeGoal.text;
      console.log(`[coder] hiding create_goal — active goal: "${preview}"`);
    }
  } else {
    goalToolHiddenLogged = false;
  }

  // Priority partition BEFORE truncation: orchestration tools required for
  // company runners (master / subordinate) must NEVER be sliced by maxTools.
  const isMasterRunner = !!args.toolContext.companyContext?.isMaster;
  const isCompanyRunner = !!args.toolContext.companyContext;
  const essentials: typeof filtered = [];
  const others: typeof filtered = [];
  for (const t of filtered) {
    if (isCompanyRunner && isEssentialCompanyTool(t.name, isMasterRunner)) {
      essentials.push(t);
    } else {
      others.push(t);
    }
  }
  essentials.sort((a, b) => a.name.localeCompare(b.name));
  others.sort((a, b) => a.name.localeCompare(b.name));
  const maxTools = getModelMaxTools(args.provider.model ?? '');
  const totalBefore = essentials.length + others.length;
  if (totalBefore > maxTools) {
    const room = Math.max(0, maxTools - essentials.length);
    const cutCount = others.length - room;
    const cutNames = others.slice(room).map((t) => t.name);
    console.log(
      `[coder] tool cap: ${totalBefore} → ${maxTools} (model limit for ${args.provider.model}) — ` +
        `${essentials.length} essential kept, ${room}/${others.length} others kept, ${cutCount} dropped. ` +
        `Dropped: ${cutNames.slice(0, 20).join(', ')}${cutNames.length > 20 ? `, … (+${cutNames.length - 20})` : ''}`,
    );
    filtered = [...essentials, ...others.slice(0, room)];
  } else {
    filtered = [...essentials, ...others];
  }

  // Bootstrap-only profile aggressively shortens descriptions. Bootstrap is
  // the most expensive turn (no cache warmth yet) and the agent only needs
  // to know WHICH tool routes WHERE — full USE/DON'T text becomes useful
  // only after promotion to navigate/admin.
  const bootstrapOnly = !!args.activeTiers
    && !args.activeTiers.has('navigate')
    && !args.activeTiers.has('admin');

  const tools: SerializedTool[] = filtered.map((t) => ({
    name: t.name,
    description: bootstrapOnly ? terseDescription(t.description) : t.description,
    parameters: t.parameters,
  }));

  return { tools, goalToolHiddenLogged };
}

export interface BuildToolsCacheKeyArgs {
  activeTiers: Set<ToolTier> | null;
  getGoalState: ToolContext['getGoalState'];
}

/**
 * Cache key driving `buildTools` re-runs. Includes goal status so that a
 * goal flipping to `complete` re-exposes `create_goal` automatically. Goal
 * contributes only its STATUS — keeps prefix caches byte-stable within a
 * status.
 */
export function buildToolsCacheKey(args: BuildToolsCacheKeyArgs): string {
  const tierKey = args.activeTiers ? Array.from(args.activeTiers).sort().join(',') : '*';
  const goalStatus = args.getGoalState?.()?.status ?? 'none';
  return `${tierKey}|goal=${goalStatus}`;
}

/**
 * Stable sha1 fingerprint of the serialized tool list. Used by
 * `SessionStore.recordSessionInput` to dedup turn-start snapshots — same
 * fingerprint = no new DB row, tier promotion = new row.
 */
export function fingerprintTools(tools: SerializedTool[]): string {
  return createHash('sha1').update(JSON.stringify(tools)).digest('hex');
}

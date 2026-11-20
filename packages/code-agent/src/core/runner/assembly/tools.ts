/**
 * Provider-facing catalog assembly: the stable workflow surface. Every other
 * authorized tool is reached through find_tools + code_exec.
 *
 * Invariants:
 *   - Always returns alphabetically sorted by name (stable for prompt cache).
 *   - Stable contracts are authored, never shortened at a sentence boundary.
 */
import { createHash } from 'node:crypto';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext, JsonSchema } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import { getModelMaxTools } from '@mcp/code-agent/providers/capabilities.js';
import { runToolFilterHook } from '@mcp/code-agent/core/hooks.js';
import { selectWorkflowCatalog } from '../../../tools/workflow-catalog.js';
import { WORKFLOW_CATALOG_CONTRACTS } from '../../../tools/catalog-contracts.js';
import { approvedPlanForRevision } from '../../../tools/plan.js';
import { readOnlySessionAuthority } from '../../policy.js';
import { isReadOnlyAgent } from '../../../agents/index.js';
import { publishedToolSource } from '../../index-tool-identity.js';

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
  /** Contextual tiers (preview, browser, api, …) that add their workflow floors. */
  activeTiers: Set<ToolTier> | null;
  /** Explicit agent/host pins: always published. */
  requiredPinnedTools?: ReadonlySet<string>;
  /** Session-level visible-tool ceiling (task preflight): `min(model cap, sessionToolCap)`. */
  sessionToolCap?: number;
  toolContext: ToolContext;
  provider: ChatProvider;
  /** Non-tool capabilities (currently skills) in the immutable attempt set. */
  catalogOnlyCapabilities?: readonly CoderTool[];
}

/** Deferral stats for the turn — null when every authorized tool is published. */
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
  // Keep the approval gate off the ordinary Build surface. A session with an
  // approved plan can reopen that review using the same interactive tool.
  const specModeBlocksPlan = args.toolContext.runner?.specMode === true;
  const planModeAllowsPlan = args.toolContext.runner?.planMode === true
    && !specModeBlocksPlan;
  const canSubmitPlan = planModeAllowsPlan || !!approvedPlanForRevision(args.toolContext);
  if (!canSubmitPlan) {
    filtered = filtered.filter((tool) => tool.name !== 'submit_plan');
  }

  if (args.globalDisabledTools?.size) {
    filtered = filtered.filter((t) => !args.globalDisabledTools!.has(t.name));
  }
  if (args.sessionDisabledTools?.size) {
    filtered = filtered.filter((t) => !args.sessionDisabledTools!.has(t.name));
  }

  return buildWorkflowTools(args, filtered, planModeAllowsPlan, specModeBlocksPlan);
}

/** Separate authorization, workflow membership and provider representation. */
function buildWorkflowTools(
  args: BuildToolsArgs, permitted: CoderTool[], planMode: boolean, specMode: boolean,
): BuildToolsResult {
  // Keep historical handlers registered for replay, but stop advertising obsolete
  // aliases or gates for a different mode. Discovery reports these as unavailable.
  let authorized = permitted.filter(tool => {
    if (tool.name === 'submit_spec') return specMode;
    if (tool.name === 'decision_gate') return planMode || !!args.requiredPinnedTools?.has(tool.name);
    return true;
  });
  const hookAllow = runToolFilterHook(args.toolContext.cwd,
    authorized.map(tool => ({ name: tool.name, source: publishedToolSource(tool) })), {
      projectName: args.toolContext.projectName, providerName: args.provider.name,
      model: args.provider.model,
      profile: args.activeTiers ? [...args.activeTiers].sort().join(',') : undefined,
    });
  if (hookAllow) authorized = authorized.filter(tool => hookAllow.has(tool.name));
  // A read-only agent loses write/process/delegation authority, not just
  // visibility: the dispatcher and discovery both derive from `authorized`.
  // Applied last so a continuation sees which openers survived every filter.
  if (isReadOnlyAgent(args.toolContext.runner?.agentId)) authorized = readOnlySessionAuthority(authorized);
  const hardLimit = args.provider.toolLimits?.maxCount;
  if (hardLimit !== undefined && (!Number.isSafeInteger(hardLimit) || hardLimit < 1)) {
    throw new Error('Invalid verified provider tool limit');
  }
  const maxTotal = Math.min(getModelMaxTools(args.provider.model ?? ''), hardLimit ?? Infinity);
  const cap = Math.min(maxTotal, args.sessionToolCap && args.sessionToolCap > 0 ? args.sessionToolCap : 28);
  const selection = selectWorkflowCatalog(authorized, {
    activeTiers: args.activeTiers, externalToolTiers: args.externalToolTiers,
    requiredPinnedTools: args.requiredPinnedTools,
    company: args.toolContext.companyContext, cap, maxTotal, hardLimit,
  });
  const serialize = (tool: CoderTool): SerializedTool => ({
    name: tool.name,
    description: !planMode && tool.name === 'task_list'
      ? 'Maintain the live progress checklist without pausing execution.'
      : tool.catalogDescription
        ?? (tool.source !== 'mcp_external' ? WORKFLOW_CATALOG_CONTRACTS[tool.name] : undefined)
        ?? tool.description,
    parameters: !planMode && tool.name === 'task_list' ? BUILD_TASK_LIST_SCHEMA : tool.parameters,
  });
  const tools = selection.tools.sort((a, b) => a.name.localeCompare(b.name)).map(serialize);
  const dropped = authorized.length - tools.length;
  if (dropped > 0) console.log(`[coder] workflow catalog: ${authorized.length} authorized → ${tools.length} direct; ${selection.protectedNames.size} workflow/control tools, ${dropped} deferred (budget ${cap})`);
  return {
    tools, protectedToolNames: selection.protectedNames,
    capInfo: dropped > 0 ? { total: authorized.length, cap: Math.max(cap, tools.length), dropped } : null,
    eligibleToolsDefChars: JSON.stringify([...authorized].sort((a, b) => a.name.localeCompare(b.name)).map(serialize)).length,
    authorizedTools: [...authorized, ...(args.catalogOnlyCapabilities ?? [])],
  };
}

export interface BuildToolsCacheKeyArgs {
  activeTiers: Set<ToolTier> | null;
  requiredPinnedTools?: ReadonlySet<string>;
}

/** Cache key driving `buildTools` re-runs (tiers and required pins). */
export function buildToolsCacheKey(args: BuildToolsCacheKeyArgs): string {
  const tierKey = args.activeTiers ? Array.from(args.activeTiers).sort().join(',') : '*';
  const requiredKey = args.requiredPinnedTools?.size
    ? Array.from(args.requiredPinnedTools).sort().join(',')
    : '';
  return `${tierKey}|required=${requiredKey}`;
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

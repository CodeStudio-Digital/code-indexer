import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { CORE_TIER_NAMES, type ToolTier } from '@mcp/code-agent/tools/tiers.js';

/**
 * Discover tool families without changing the stable public catalog.
 * Legacy runners can still request tier projection through this alias.
 */

export interface CustomTierInfo {
  displayName: string;
  toolCount: number;
}

/**
 * Build the expand_toolset tool with a dynamic tier enum that includes
 * both the core tiers and any custom tiers from dynamic tool contributors.
 *
 * When no custom tiers exist, this produces the exact same tool as the
 * previous static export — zero behavioral change.
 */
export function buildExpandTools(
  customTiers?: ReadonlyMap<string, CustomTierInfo>,
  options?: {
    beforeExpand?: (tier: string) => Promise<void>;
    isTierAvailable?: (tier: string) => boolean;
    toolNamesForTier?: (tier: string) => readonly string[];
  },
): CoderTool[] {
  // Every built-in functional tier is addressable. Contextual tiers are
  // normally auto-active when their runtime capability is present, but
  // keeping them in this contract makes find_tools → expand_toolset coherent
  // for recovery/custom-agent flows. Registration remains the hard boundary:
  // expanding a tier cannot conjure tools that were not registered.
  const coreExpandable = [...CORE_TIER_NAMES].filter((tier) => tier !== 'bootstrap');
  const customNames = customTiers ? [...customTiers.keys()].sort() : [];
  const allTiers = [...coreExpandable, ...customNames];

  // Build the valid tiers set for validation (includes bootstrap for error messages)
  const validTiers = new Set<string>(['bootstrap', ...allTiers]);

  // Build description with custom tier docs
  let description =
    'Discover a family of tools; use find_tools for input schemas and code_exec for hidden non-interactive calls.\n\n' +
    'Tiers:\n' +
    '- "navigate": write_file, edit_file, manage_path, run_command, git_status/diff/log, ' +
    'task_complete (inline-mode closer), and deeper MCP navigation (find_references, trace_usage, ' +
    'get_dependencies, prepare_edit, get_symbol_body, etc.).\n' +
    '- "admin": git_add/commit/branch, mcp__index_project, mcp__get_costs, ' +
    'and other rarely-needed admin tools. Discovery does not authorize mutations.\n' +
    '- "master": company orchestration surface — spawn_subordinate_agent, ' +
    'wait_for_subordinates, list_subordinates, forward_to_agent, kanban_list_cards, ' +
    'kanban_get_card, kanban_create_card, kanban_move_card, kanban_assign_agent, and ' +
    'related delegation tools, available in company-master sessions.\n' +
    '- "preview": live-app DevTools over a dedicated window — preview_open/navigate, ' +
    'preview_snapshot/console/network/eval/screenshot/inspect_css/performance/memory/storage, and ' +
    'preview_click/fill/type/press/wait_for/scroll/hover/double_click/right_click. Open the dev-server URL first.\n' +
    '- "diagram": author draw.io diagrams — diagram_create/update/read/list/export. Saves real ' +
    '.drawio files rendered in a live embedded editor.\n' +
    '- "db": operate the databases registered in the Databases tab — db_list, progressive db_schema ' +
    '(paged catalog or one table), db_query (single SQL statement, writes require approval) and db_command ' +
    '(MongoDB/Redis).\n' +
    '- Contextual capabilities (`company`, `sandbox`, `qa`, `app`) are registered by their owning runtime.';

  if (customTiers && customTiers.size > 0) {
    description += '\n\nExternal tool groups (on-demand):';
    for (const [name, info] of customTiers) {
      description += `\n- "${name}": ${info.toolCount} tools from ${info.displayName}.`;
    }
  }

  description +=
    '\n\nUse this only to browse a family. For a known operation, find_tools returns its input schema directly. ' +
    'Hidden non-interactive tools run inside code_exec; interactive controls use their exposed top-level call. ' +
    'Discovery keeps the public catalog unchanged and does not grant permission.';

  const expandToolset: CoderTool = {
    name: 'expand_toolset',
    effectBoundary: 'control',
    executionClass: 'control',
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    description,
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: allTiers,
          description:
            'Which tool family to inspect.' +
            (customNames.length > 0
              ? ` Core: "navigate" (reads+writes+nav), "admin" (git mutations). Custom: ${customNames.map((n) => `"${n}"`).join(', ')}.`
              : ' "navigate" covers reads+writes+local nav; "admin" covers git mutations and snapshot admin.'),
        },
        reason: {
          type: 'string',
          description: 'Short one-line reason — helps the user understand why the agent needed more tools.',
        },
      },
      required: ['tier'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      const tier = String(args.tier ?? '').trim() as ToolTier;
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!validTiers.has(tier) && options?.beforeExpand) {
        try {
          await options.beforeExpand(tier);
        } catch (e) {
          console.warn(
            `[expand_toolset] catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (!validTiers.has(tier) && !options?.isTierAvailable?.(tier)) {
        return err(`Invalid tier '${tier}'. Valid options: ${allTiers.join(', ')}.`);
      }
      if (tier === 'bootstrap') {
        return err("Bootstrap tier is always active — no need to expand to it.");
      }
      ctx.signal?.throwIfAborted();

      const runner = ctx.runner;
      if (runner?.stableToolCatalog) {
        const names = (options?.toolNamesForTier?.(tier) ?? [])
          .filter(name => runner.discoveryState(name).authorization !== 'blocked');
        return { ...ok(`Tools in '${tier}': ${names.join(', ') || 'no registered tools'}. The public catalog remains fixed. Use find_tools({query: "exact tool name", limit: 1}) for the schema, then code_exec for non-interactive calls.`),
          structuredData: { tier, state: 'discovered', tools: names, projection: runner.projectionReceipt ?? null } };
      }
      if (!runner || typeof (runner as unknown as { promoteTier?: unknown }).promoteTier !== 'function') {
        return err('expand_toolset requires a runner that supports tier promotion.');
      }
      const before = runner.activeTiers ? Array.from(runner.activeTiers).sort().join(',') : '?';
      runner.promoteTier(tier);
      for (const name of options?.toolNamesForTier?.(tier) ?? []) runner.requestedToolNames?.add(name);
      const after = runner.activeTiers ? Array.from(runner.activeTiers).sort().join(',') : '?';
      const discovery: import('@mcp/agent-runtime-contracts').DiscoveryReceipt = {
        schemaVersion: 1, revision: runner.projectionReceipt?.discovery?.revision ?? 'pending',
        tools: (options?.toolNamesForTier?.(tier) ?? []).map(name => ({ name,
          state: runner.visibleToolNames?.has(name) ? 'callable' : 'activated',
          ...(!runner.visibleToolNames?.has(name) ? { reason: 'pending_projection' } : {}) })),
      };
      if (before === after) {
        return { ...ok(`Tier '${tier}' was already active. Current tiers: ${after}. Consult the projection receipt for actual visibility.`),
          structuredData: { tier, state: 'already_active', discovery, projection: runner.projectionReceipt ?? null } };
      }
      const tail = reason ? ` Reason: ${reason}` : '';
      const isCustom = !CORE_TIER_NAMES.has(tier);
      const toolNote = isCustom && customTiers?.has(tier)
        ? ` (${customTiers.get(tier)!.toolCount} tools from ${customTiers.get(tier)!.displayName})`
        : '';
      return {
        ...ok(`Tier '${tier}'${toolNote} requested. Active tiers: ${after}. Projection is pending; the next turn includes the tools that fit the provider limits.${tail}`),
        structuredData: { tier, state: 'pending_projection', discovery, requested: options?.toolNamesForTier?.(tier) ?? [] },
      };
    },
  };

  return [expandToolset];
}

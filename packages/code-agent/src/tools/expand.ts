import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { CORE_TIER_NAMES, type ToolTier } from '@mcp/code-agent/tools/tiers.js';

/**
 * expand_toolset — runtime escape hatch for the tiered tool system.
 *
 * The agent starts at the 'bootstrap' tier with ~13 essential tools. If it
 * decides it needs deeper navigation (find_references, edit_file, etc.) or
 * admin tools (git_commit, add_snapshot, index_project), it calls this tool
 * to unlock the corresponding tier. The runner then rebuilds its tools array
 * on the NEXT turn with the expanded set.
 *
 * Custom tiers (from external MCP servers and installed plugins) can also be
 * unlocked on-demand. The tool's `tier` enum is dynamically generated to
 * include both core tiers and every runtime tool group.
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
    'Unlock a higher tier of tools for this session.\n\n' +
    'Tiers:\n' +
    '- "navigate": write_file, edit_file, create_file, manage_path, run_command, git_status/diff/log, ' +
    'task_complete (inline-mode closer), and deeper MCP navigation (find_references, trace_usage, ' +
    'get_dependencies, prepare_edit, get_symbol_body, etc.). Unlock this BEFORE editing code ' +
    'or running shell commands. (spawn_agent + execute_tasks + update_task are bootstrap-tier — ' +
    'available without unlocking.)\n' +
    '- "admin": git_add/commit/branch, mcp__index_project, mcp__get_costs, ' +
    'and other rarely-needed admin tools. Unlock ONLY when the user explicitly asks for them.\n' +
    '- "master": company orchestration surface — spawn_subordinate_agent, ' +
    'wait_for_subordinates, list_subordinates, forward_to_agent, kanban_list_cards, ' +
    'kanban_get_card, kanban_create_card, kanban_move_card, kanban_assign_agent, and ' +
    'related delegation tools. Auto-activated for company-master sessions; call this ' +
    'explicitly if the master surface looks missing (e.g. after recovery agent boot).\n' +
    '- "preview": live-app DevTools over a dedicated window — preview_open/navigate, ' +
    'preview_snapshot/console/network/eval/screenshot/inspect_css/performance/memory/storage, and ' +
    'preview_click/fill/type/press/wait_for/scroll/hover/double_click/right_click. Unlock to SEE, inspect, or drive ' +
    'the running app (open the dev-server URL first). Auto-active for builder/dev-server projects.\n' +
    '- "diagram": author draw.io diagrams — diagram_create/update/read/list/export. Saves real ' +
    '.drawio files rendered in a live embedded editor. Unlock to draw architecture, flowcharts, ' +
    'network/ER/sequence/C4. Auto-active for the `diagram` agent.\n' +
    '- "db": operate the databases registered in the Databases tab — db_list, progressive db_schema ' +
    '(paged catalog or one table), db_query (single SQL statement, writes require approval) and db_command ' +
    '(MongoDB/Redis). Unlock when the task needs to inspect or change data in a registered database.\n' +
    '- Contextual capabilities (`company`, `sandbox`, `qa`, `app`, `design-system-studio`, ' +
    '`design-system-consumer`, `sprite-studio`) are auto-activated by their owning runtime. ' +
    'Expand them manually only during recovery or an explicitly configured custom-agent flow.';

  if (customTiers && customTiers.size > 0) {
    description += '\n\nExternal tool groups (on-demand):';
    for (const [name, info] of customTiers) {
      description += `\n- "${name}": ${info.toolCount} tools from ${info.displayName}. Unlock when the task involves ${info.displayName}.`;
    }
  }

  description +=
    '\n\nWHEN TO USE: call this the turn BEFORE you need tools from a higher tier. Once unlocked, ' +
    'the tier stays active for the rest of the session — you never need to call it twice for ' +
    'the same tier.\n\n' +
    "DON'T: call this speculatively. Call it only after the bootstrap tools have told you the " +
    'task actually requires writes, shell commands, git mutations, or external tools.';

  const expandToolset: CoderTool = {
    name: 'expand_toolset',
    description,
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: allTiers,
          description:
            'Which tier to unlock.' +
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
      const tier = String(args.tier ?? '').trim() as ToolTier;
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!validTiers.has(tier)) {
        return err(`Invalid tier '${tier}'. Valid options: ${allTiers.join(', ')}.`);
      }
      if (tier === 'bootstrap') {
        return err("Bootstrap tier is always active — no need to expand to it.");
      }
      const runner = ctx.runner;
      if (!runner || typeof (runner as unknown as { promoteTier?: unknown }).promoteTier !== 'function') {
        return err('expand_toolset requires a runner that supports tier promotion.');
      }
      const before = runner.activeTiers ? Array.from(runner.activeTiers).sort().join(',') : '?';
      runner.promoteTier(tier);
      const after = runner.activeTiers ? Array.from(runner.activeTiers).sort().join(',') : '?';
      if (before === after) {
        return ok(`Tier '${tier}' was already active. No change. Current tiers: ${after}.`);
      }
      const tail = reason ? ` Reason: ${reason}` : '';
      const isCustom = !CORE_TIER_NAMES.has(tier);
      const toolNote = isCustom && customTiers?.has(tier)
        ? ` (${customTiers.get(tier)!.toolCount} tools from ${customTiers.get(tier)!.displayName})`
        : '';
      return ok(
        `Tier '${tier}'${toolNote} unlocked. Active tiers: ${after}. The expanded tool list is visible starting next turn.${tail}`,
      );
    },
  };

  return [expandToolset];
}

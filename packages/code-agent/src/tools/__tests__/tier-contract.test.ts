/**
 * Registry-wide tier contract.
 *
 * The historical gotcha: `getToolTier` returns `bootstrap` for any tool not
 * listed in a tier set, so a tool added to the registry but forgotten in
 * tiers.ts silently ships on turn 1 of EVERY session. That is how `code_exec`
 * (the #1 tool, 16.7% of all calls), the shared-drive/messaging families, the
 * builder tools, and the MCP-resource tools all became invisible always-on
 * passengers.
 *
 * This test imports every statically-importable tool module (the bulk of the
 * registry) plus the known factory-built always-on tools, and asserts each name
 * is placed in an EXPLICIT tier set — i.e. `getToolTier(name, _, {strict})`
 * does not throw. A new tool added without a tier entry fails here instead of
 * quietly inflating the prompt.
 *
 * Out of scope (resolved at runtime, not by name): internal bridge tools
 * (`mcp__*`) and external MCP / plugin tools (`ext_*`), which are tier-mapped
 * via `externalToolTiers`.
 */
import { describe, expect, it } from 'vitest';
import {
  getToolTier,
  allTieredToolNames,
  BOOTSTRAP_TOOLS,
  NAVIGATE_TOOLS,
  MASTER_TOOLS,
} from '@mcp/code-agent/tools/tiers.js';

// ── Static tool arrays (code-agent) ───────────────────────────────────────
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { applyPatchTool } from '@mcp/code-agent/tools/apply-patch.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitTools } from '@mcp/code-agent/tools/git.js';
import { planTools } from '@mcp/code-agent/tools/plan.js';
import { specTools } from '@mcp/code-agent/tools/spec/index.js';
import { tasksTools } from '@mcp/code-agent/tools/tasks.js';
import { interactionTools } from '@mcp/code-agent/tools/interaction.js';
import { toolOutputTools } from '@mcp/code-agent/tools/tool-output.js';
import { diagnosticsTools } from '@mcp/code-agent/tools/diagnostics.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { execCommandTools } from '@mcp/code-agent/tools/exec-command.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { httpTools } from '@mcp/code-agent/tools/http.js';
import { globTools } from '@mcp/code-agent/tools/glob.js';
import { ragSearchDocsTools } from '@mcp/code-agent/tools/rag-search-docs.js';
import { ragReadDocTools } from '@mcp/code-agent/tools/rag-read-doc.js';
import { todoTools } from '@mcp/code-agent/tools/todo.js';
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import { listAgentsTools } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgentsTools } from '@mcp/code-agent/tools/wait-agents.js';
import { sendMessageTools } from '@mcp/code-agent/tools/send-message.js';
import { sendInputTools } from '@mcp/code-agent/tools/send-input.js';
import { followupTaskTools } from '@mcp/code-agent/tools/followup-task.js';
import { worktreeTools } from '@mcp/code-agent/tools/worktree.js';
import { apiClientTools } from '@mcp/code-agent/tools/api-client/index.js';

// ── Static tool arrays (@mcp/company — builder mode) ───────────────────────
import { sandboxTools } from '@mcp/company/tools/sandbox-tools.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import { envTools } from '@mcp/company/tools/env-tools.js';
import { databaseTools } from '@mcp/company/tools/database-tools.js';

type NamedTool = { name: string };
const arr = (x: NamedTool | readonly NamedTool[]): NamedTool[] => (Array.isArray(x) ? [...x] : [x as NamedTool]);

const STATIC_TOOLS: NamedTool[] = [
  ...fsTools, applyPatchTool, ...shellTools, ...gitTools, ...planTools, ...specTools,
  ...tasksTools, ...interactionTools, ...toolOutputTools, ...diagnosticsTools, ...lspTools,
  ...execCommandTools, ...webTools, ...httpTools, ...globTools, ...ragSearchDocsTools,
  ...ragReadDocTools,
  ...todoTools, ...viewImageTools, ...previewTools, ...goalTools, ...listAgentsTools,
  ...waitAgentsTools, ...sendMessageTools, ...sendInputTools, ...followupTaskTools,
  ...worktreeTools, ...sandboxTools, ...docsTools, ...envTools, ...databaseTools,
  ...apiClientTools,
].flatMap(arr);

/**
 * Factory-built tools that register on (or near) turn 1 but aren't static
 * arrays. We assert their NAMES are tiered without executing the factories
 * (which need a live registry / orchestrator / DB). Keep in sync when a new
 * always-on factory tool is added.
 */
const FACTORY_ALWAYS_ON = [
  'code_exec', 'expand_toolset', 'find_tools', 'spawn_agent', 'request_review', 'self_review',
  'invoke_skill', 'get_skills_list', 'get_skill_content', 'list_skill_namespaces', 'create_skill',
  'read_plan', 'save_note', 'list_notes', 'recall_investigations',
  'mcp_list_resources', 'mcp_read_resource',
  // DocsAgent escalation — installed per-runner via installDocsDeepResearch
  // (string only: importing @mcp/docs-agent here would create a cycle).
  'docs_deep_research',
  // DS consumer set (builder project linked to a published design system).
  'ds_components', 'ds_component', 'ds_docs',
];

const isRuntimeTiered = (name: string) => name.startsWith('mcp__') || name.startsWith('ext_');

describe('tier contract — every registered tool has an explicit tier', () => {
  it('no static tool rides the silent bootstrap fallback', () => {
    const union = allTieredToolNames();
    const orphans = STATIC_TOOLS
      .map((t) => t.name)
      .filter((n) => !isRuntimeTiered(n) && !union.has(n));
    expect(orphans, `untiered tools (add them to a set in tiers.ts):\n${orphans.join('\n')}`).toEqual([]);
  });

  it('strict getToolTier does not throw for any static tool', () => {
    for (const t of STATIC_TOOLS) {
      if (isRuntimeTiered(t.name)) continue;
      expect(() => getToolTier(t.name, undefined, { strict: true }), t.name).not.toThrow();
    }
  });

  it('known factory-built always-on tools are tiered', () => {
    const union = allTieredToolNames();
    const orphans = FACTORY_ALWAYS_ON.filter((n) => !union.has(n));
    expect(orphans).toEqual([]);
  });

  it('strict mode throws for a genuinely unknown tool', () => {
    expect(() => getToolTier('definitely_not_a_real_tool_xyz', undefined, { strict: true })).toThrow();
  });
});

describe('tier contract — Phase A/B placements are locked', () => {
  it('keeps the workhorses + anti-deadlock tools always-on (bootstrap)', () => {
    for (const n of ['code_exec', 'view_image', 'submit_spec', 'create_goal', 'update_goal', 'glob', 'mcp__read_file']) {
      expect(getToolTier(n), n).toBe('bootstrap');
    }
  });

  it('keeps the DS consumer queries always-on (bootstrap)', () => {
    for (const n of ['ds_components', 'ds_component', 'ds_docs']) {
      expect(getToolTier(n), n).toBe('bootstrap');
    }
  });

  it('demotes the cold tools to navigate (off turn-1 surface)', () => {
    for (const n of [
      'list_tasks', 'cancel_tasks', 'delete_tasks', 'archive_task_list', 'update_task',
      'read_plan', 'list_notes', 'get_goal',
      'mcp__search_memory', 'mcp__query_snapshots', 'mcp__get_context_for',
      'mcp__list_projects', 'mcp__get_project_stats', 'mcp_list_resources',
    ]) {
      expect(getToolTier(n), n).toBe('navigate');
    }
  });

  it('drops the retired kanban aliases from every tier (strict mode throws)', () => {
    for (const n of [
      'kanban_my_comment', 'kanban_my_checklist',
      'kanban_update_card', 'kanban_add_comment', 'kanban_update_checklist',
    ]) {
      expect(() => getToolTier(n, undefined, { strict: true }), n).toThrow();
    }
  });

  it('places company/builder always-on tools at bootstrap (within their session)', () => {
    for (const n of ['write_shared_file', 'send_message', 'qa_start_run', 'db_query', 'env_set', 'docs_write']) {
      expect(getToolTier(n), n).toBe('bootstrap');
    }
  });

  it('master-only review tool lives in the master tier', () => {
    expect(MASTER_TOOLS.has('review_subordinate_work')).toBe(true);
    expect(getToolTier('review_subordinate_work')).toBe('master');
  });

  it('bootstrap and navigate are disjoint', () => {
    const overlap = [...BOOTSTRAP_TOOLS].filter((n) => NAVIGATE_TOOLS.has(n));
    expect(overlap).toEqual([]);
  });
});

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
  COMPANY_TOOLS,
  contextualTiersForRuntime,
  getAllKnownToolsMeta,
  NAVIGATE_TOOLS,
  MASTER_TOOLS,
  QA_TOOLS,
  SANDBOX_TOOLS,
  TIER_COUNTS,
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
import { viewImageTools } from '@mcp/code-agent/tools/view-image.js';
import { previewTools } from '@mcp/code-agent/tools/preview/index.js';
import { browserTools } from '@mcp/code-agent/tools/browser/index.js';
import { listAgentsTools } from '@mcp/code-agent/tools/list-agents.js';
import { waitAgentsTools } from '@mcp/code-agent/tools/wait-agents.js';
import { sendMessageTools } from '@mcp/code-agent/tools/send-message.js';
import { sendInputTools } from '@mcp/code-agent/tools/send-input.js';
import { followupTaskTools } from '@mcp/code-agent/tools/followup-task.js';
import { worktreeTools } from '@mcp/code-agent/tools/worktree.js';
import { apiClientTools } from '@mcp/code-agent/tools/api-client/index.js';
import { dbTools } from '@mcp/code-agent/tools/db/index.js';

// ── Static tool arrays (@mcp/company — builder mode) ───────────────────────
import { sandboxTools } from '@mcp/company/tools/sandbox-tools.js';
import { docsTools } from '@mcp/company/tools/docs-tools.js';
import { envTools } from '@mcp/company/tools/env-tools.js';

type NamedTool = { name: string };
const arr = (x: NamedTool | readonly NamedTool[]): NamedTool[] => (Array.isArray(x) ? [...x] : [x as NamedTool]);

const STATIC_TOOLS: NamedTool[] = [
  ...fsTools, applyPatchTool, ...shellTools, ...gitTools, ...planTools, ...specTools,
  ...tasksTools, ...interactionTools, ...toolOutputTools, ...diagnosticsTools, ...lspTools,
  ...execCommandTools, ...webTools, ...httpTools, ...globTools, ...ragSearchDocsTools,
  ...ragReadDocTools,
  ...viewImageTools, ...previewTools, ...browserTools, ...listAgentsTools,
  ...waitAgentsTools, ...sendMessageTools, ...sendInputTools, ...followupTaskTools,
  ...worktreeTools, ...sandboxTools, ...docsTools, ...envTools,
  ...apiClientTools, ...dbTools,
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
  // Agent Memory (migration 181): durable write + read on the turn-1 surface.
  'remember', 'recall_memory',
  'mcp_list_resources', 'mcp_read_resource',
  // DocsAgent escalation — installed per-runner via installDocsDeepResearch
  // (string only: importing @mcp/docs-agent here would create a cycle).
  'docs_deep_research',
  // Contextual factories (their dedicated tiers auto-activate at runtime).
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
    for (const n of ['code_exec', 'view_image', 'submit_spec', 'glob', 'mcp__read_file']) {
      expect(getToolTier(n), n).toBe('bootstrap');
    }
  });

  it('demotes the cold tools to navigate (off turn-1 surface)', () => {
    for (const n of [
      'list_tasks', 'cancel_tasks', 'delete_tasks', 'archive_task_list', 'update_task',
      'read_plan', 'list_notes',
      // mcp__get_repo_map: explicitly tiered so it no longer rides the
      // getToolTier bootstrap fallback (regression guard for the leak fix).
      'mcp__search_memory', 'mcp__get_repo_map', 'mcp_list_resources',
    ]) {
      expect(getToolTier(n), n).toBe('navigate');
    }
  });

  it('drops the retired cross-project / snapshot MCP tools (strict mode throws)', () => {
    for (const n of [
      'mcp__list_projects', 'mcp__get_project_stats', 'mcp__search_global',
      'mcp__delete_project', 'mcp__get_project_context', 'mcp__get_context_for',
      'mcp__query_snapshots', 'mcp__list_snapshots',
      'mcp__add_snapshot', 'mcp__update_snapshot', 'mcp__delete_snapshot',
      'mcp__get_snapshot_history',
    ]) {
      expect(() => getToolTier(n, undefined, { strict: true }), n).toThrow();
    }
  });

  it('drops the 0-call symbol/overview MCP tools retired by the 2026-07 tool audit (strict mode throws)', () => {
    for (const n of [
      'mcp__get_file_structure', 'mcp__search_concepts', 'mcp__search_by_kind',
      'mcp__get_class_members', 'mcp__get_symbol_details', 'mcp__get_architecture',
    ]) {
      expect(() => getToolTier(n, undefined, { strict: true }), n).toThrow();
    }
  });

  it('drops the retired duplicate tools (strict mode throws)', () => {
    // task_list aliases; multi_edit (edit_file with edits); create_file (write_file);
    // poll_session (write_stdin with empty chars).
    const catalog = new Set(getAllKnownToolsMeta().map(tool => tool.name));
    for (const n of ['todo_write', 'update_todo', 'submit_tasks', 'multi_edit', 'create_file', 'poll_session']) {
      expect(() => getToolTier(n, undefined, { strict: true }), n).toThrow();
      expect(catalog.has(n), n).toBe(false);
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

  it('places every contextual product surface in its own tier', () => {
    expect(getToolTier('write_shared_file')).toBe('company');
    expect(getToolTier('send_message')).toBe('company');
    expect(getToolTier('env_set')).toBe('company');
    expect(getToolTier('docs_write')).toBe('company');
    expect(getToolTier('service_restart')).toBe('sandbox');
    expect(getToolTier('qa_start_run')).toBe('qa');
  });

  it('keeps every functional family out of the global bootstrap tier', () => {
    const contextual = new Set([
      ...COMPANY_TOOLS,
      ...SANDBOX_TOOLS,
      ...QA_TOOLS,
      ...MASTER_TOOLS,
    ]);
    expect([...BOOTSTRAP_TOOLS].filter((name) => contextual.has(name))).toEqual([]);
  });

  it('does not advertise or tier retired App Studio tools', () => {
    const retired = ['app_get_state', 'app_get_plan', 'app_update_plan',
      'app_upsert_work_items', 'app_request_decision', 'app_request_plan_approval',
      'app_dispatch_ready_work', 'app_record_work_evidence', 'app_get_db_state',
      'app_update_database', 'app_run_checks'];
    const catalog = new Set(getAllKnownToolsMeta().map(tool => tool.name));
    for (const name of retired) {
      expect(allTieredToolNames().has(name)).toBe(false);
      expect(catalog.has(name)).toBe(false);
      expect(() => getToolTier(name, undefined, { strict: true })).toThrow();
    }
  });

  it('db_* v2 tools live in the dedicated db tier (moved out of BUILDER_TOOLS)', () => {
    for (const n of ['db_list', 'db_schema', 'db_query', 'db_command']) {
      expect(getToolTier(n), n).toBe('db');
    }
  });

  it('master-only review tool lives in the master tier', () => {
    expect(MASTER_TOOLS.has('review_subordinate_work')).toBe(true);
    expect(getToolTier('review_subordinate_work')).toBe('master');
  });

  it('master tier covers every master factory family, including batch tools', () => {
    for (const name of [
      'approve_subordinate_plans', 'recommend_role', 'broadcast_to_roles',
      'kanban_plan_graph', 'list_containers', 'read_container_logs',
    ]) {
      expect(MASTER_TOOLS.has(name), name).toBe(true);
      expect(getToolTier(name), name).toBe('master');
    }
  });

  it('catalog metadata and counts expose the same dedicated tier identities', () => {
    const metadata = getAllKnownToolsMeta();
    const names = metadata.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const byName = new Map(metadata.map((tool) => [tool.name, tool]));
    const functionalTools = new Set([
      ...COMPANY_TOOLS,
      ...SANDBOX_TOOLS,
      ...QA_TOOLS,
      ...MASTER_TOOLS,
    ]);
    for (const name of functionalTools) {
      expect(byName.get(name)?.description.trim(), `${name} needs a searchable description`).not.toBe('');
    }
    expect(TIER_COUNTS).toMatchObject({
      company: COMPANY_TOOLS.size,
      sandbox: SANDBOX_TOOLS.size,
      qa: QA_TOOLS.size,
    });
  });

  it('bootstrap and navigate are disjoint', () => {
    const overlap = [...BOOTSTRAP_TOOLS].filter((n) => NAVIGATE_TOOLS.has(n));
    expect(overlap).toEqual([]);
  });
});

describe('contextual tier activation', () => {
  it('activates every registered product capability without polluting bootstrap', () => {
    expect([...contextualTiersForRuntime({
      company: true,
      sandbox: true,
      qa: true,
      isMaster: true,
    })].sort()).toEqual([
      'company',
      'master',
      'qa',
      'sandbox',
    ]);
  });

  it.each(['qa', 'frontend', 'ux', 'fullstack'])(
    'gives visual Company role %s the preview capability on turn 1',
    (companyRole) => {
      expect(contextualTiersForRuntime({ company: true, companyRole }).has('preview')).toBe(true);
    },
  );

  it('gives database roles and dedicated agents their defining tiers', () => {
    expect(contextualTiersForRuntime({ company: true, companyRole: 'database' }).has('db')).toBe(true);
    expect(contextualTiersForRuntime({ agentId: 'app_db' }).has('db')).toBe(true);
    expect(contextualTiersForRuntime({ agentId: 'api' }).has('api')).toBe(true);
    expect(contextualTiersForRuntime({ agentId: 'diagram' }).has('diagram')).toBe(true);
  });
});

/**
 * Tests for priority-based catalog trimming (tool-priority.ts + buildTools).
 *
 * Contract under test:
 *   - selectUnderCap is deterministic (input order never changes the result)
 *   - drop order: custom tier → non-core preview → admin → navigate-cold →
 *     bootstrap-cold → hot tails last
 *   - NEVER_TRIM tools always survive the model cap
 *   - buildTools output stays globally alphabetical (prompt-cache invariant)
 *   - CODER_PRIORITY_TRIM_DISABLE=1 restores the legacy alphabetical tail-cut
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { NEVER_TRIM, ROLE_CAPABILITY_FLOOR, selectUnderCap } from '../tool-priority.js';
import { buildTools } from '../../core/runner/assembly/tools.js';
import type { ToolRegistry } from '../../core/registry.js';
import type { ToolContext } from '../../core/tool.js';
import type { ChatProvider } from '../../providers/adapter.js';
import type { ToolTier } from '../tiers.js';
import { getToolTier, MASTER_TOOLS } from '../tiers.js';

// Long second sentence: terseDescription only trims past 150 chars, so the
// fixture must cross that threshold for the terse-mode assertions to bite.
const TAIL =
  'Second sentence with USE/DONT details that keeps going long enough to cross the one-hundred-and-fifty character terse threshold used by terseDescription in production.';
const named = (n: string) => ({
  name: n,
  description: `${n} description. ${TAIL}`,
  parameters: { type: 'object' as const, properties: {} },
  source: 'native',
});

const BOOTSTRAP_SET = [
  'read_file', 'list_directory', 'glob', 'todo_write', 'code_exec', 'expand_toolset',
  'find_tools', 'ask_user', 'submit_plan', 'task_list', 'submit_tasks',
  'save_note', 'recall_investigations', 'get_tool_output', 'invoke_skill',
  'rag_search_docs', 'rag_read_doc', 'get_skills_list', 'get_skill_content',
  'list_skill_namespaces', 'mcp__get_project_pulse', 'mcp__search', 'mcp__grep_code',
  'mcp__read_file', 'mcp__list_directory', 'view_image',
  'submit_spec', 'request_review', 'self_review', 'spawn_agent', 'execute_tasks', 'update_todo',
];
const NAVIGATE_SET = [
  'write_file', 'edit_file', 'multi_edit', 'create_file', 'run_command', 'get_diagnostics',
  'git_status', 'git_diff', 'git_log', 'web_fetch', 'web_search', 'task_complete',
  'decision_gate', 'list_tasks', 'read_plan', 'list_notes', 'mcp__find_references', 'mcp__save_memory',
  'mcp__get_file_skeleton',
];
const ADMIN_SET = ['git_add', 'git_commit', 'git_branch'];
const PREVIEW_SET = ['preview_open', 'preview_click'];
const CUSTOM_SET = ['cf__deploy_worker'];

const externalToolTiers = new Map<string, ToolTier>([['cf__deploy_worker', 'cloudflare']]);
const tierOf = (n: string): ToolTier => getToolTier(n, externalToolTiers);

function makeArgs(model: string) {
  const all = [...BOOTSTRAP_SET, ...NAVIGATE_SET, ...ADMIN_SET, ...PREVIEW_SET, ...CUSTOM_SET].map(named);
  return {
    registry: { list: () => all } as unknown as ToolRegistry,
    activeTiers: new Set<ToolTier>(['bootstrap', 'navigate', 'admin', 'preview', 'cloudflare']),
    externalToolTiers,
    toolContext: {
      cwd: tmpdir(),
      projectName: 'test',
      runner: { planMode: true },
    } as unknown as ToolContext,
    provider: { name: 'zai', model } as unknown as ChatProvider,
  };
}

afterEach(() => {
  delete process.env.CODER_PRIORITY_TRIM_DISABLE;
  delete process.env.CODER_TOOL_CAP_DEFAULT;
});

describe('selectUnderCap', () => {
  const tools = ['git_commit', 'preview_open', 'write_file', 'list_tasks', 'mcp__search', 'cf__deploy_worker'].map(named);

  it('keeps hot tiers and drops custom/preview/admin first', () => {
    const { kept, dropped } = selectUnderCap(tools, 2, tierOf);
    expect(kept.map((t) => t.name)).toEqual(['mcp__search', 'write_file']);
    expect(dropped).toContain('cf__deploy_worker');
    expect(dropped).toContain('preview_open');
    expect(dropped).toContain('git_commit');
  });

  it('is deterministic under input permutation', () => {
    const a = selectUnderCap(tools, 3, tierOf);
    const b = selectUnderCap([...tools].reverse(), 3, tierOf);
    expect(a.kept.map((t) => t.name).sort()).toEqual(b.kept.map((t) => t.name).sort());
    expect(a.dropped.sort()).toEqual(b.dropped.sort());
  });

  it('returns everything when under the cap', () => {
    const { kept, dropped } = selectUnderCap(tools, 100, tierOf);
    expect(kept).toHaveLength(tools.length);
    expect(dropped).toHaveLength(0);
  });
});

describe('buildTools — priority trim at a weak-model cap', () => {
  it('does not expose or re-pin submit_plan for a Build-mode runner', () => {
    const base = makeArgs('glm-4.5-flash');
    const tools = buildTools({
      ...base,
      pinnedTools: new Set(['submit_plan']),
      toolContext: {
        ...base.toolContext,
        runner: { planMode: false },
      } as unknown as ToolContext,
    }).tools;
    const names = tools.map((tool) => tool.name);

    expect(names).not.toContain('submit_plan');
    expect(names).toContain('edit_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
    const taskList = tools.find((tool) => tool.name === 'task_list');
    expect(taskList?.parameters.properties?.gate).toMatchObject({ enum: ['track'] });
    expect(taskList?.description).not.toMatch(/approv/i);
  });

  it('never exposes or re-pins submit_plan while the runner is in spec mode', () => {
    const base = makeArgs('glm-4.5-flash');
    const names = buildTools({
      ...base,
      pinnedTools: new Set(['submit_plan']),
      toolContext: {
        ...base.toolContext,
        runner: { planMode: false, specMode: true },
      } as unknown as ToolContext,
    }).tools.map((tool) => tool.name);

    expect(names).not.toContain('submit_plan');
    expect(names).toContain('submit_spec');
  });

  it('caps at the focused 28-tool default, keeps NEVER_TRIM + hot core, drops cold tiers', () => {
    const res = buildTools(makeArgs('glm-4.5-flash'));
    const names = res.tools.map((t) => t.name);

    expect(res.capInfo).not.toBeNull();
    expect(res.capInfo!.cap).toBe(28);
    expect(names.length).toBeLessThanOrEqual(28);

    // Every NEVER_TRIM member present in the registry survives.
    for (const n of NEVER_TRIM) {
      if (![...BOOTSTRAP_SET, ...NAVIGATE_SET].includes(n)) continue;
      expect(names, `NEVER_TRIM tool ${n} must survive`).toContain(n);
    }
    // Regression: task_list is the ONE always-on task tool (todos+tasks merge);
    // the cap must never drop it, even at the most aggressive default cap.
    expect(names).toContain('task_list');
    // plan.txt requires decision_gate for genuine multi-option forks, so a
    // compact catalog must keep the direct interactive tool available.
    expect(names).toContain('decision_gate');
    // Hot working core survives; cold tiers die first.
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('run_command');
    expect(NEVER_TRIM.has('write_file')).toBe(true);
    expect(NEVER_TRIM.has('edit_file')).toBe(true);
    expect(NEVER_TRIM.has('run_command')).toBe(true);
    expect(names).toContain('mcp__search');
    expect(names).not.toContain('cf__deploy_worker');
    // The minimal open→snapshot/interact→validate browser loop is protected
    // whenever the preview tier is active; cold preview helpers still trim.
    expect(names).toContain('preview_open');
    expect(names).toContain('preview_click');
    expect(names).not.toContain('git_commit');
    expect(names).not.toContain('list_tasks'); // navigate-cold (Phase B)
  });

  it('emits a globally alphabetical list (presentation invariant)', () => {
    const names = buildTools(makeArgs('glm-4.5-flash')).tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('keeps the focused 28-tool default and discovers cold capabilities on demand', () => {
    const res = buildTools(makeArgs('claude-opus-4-7'));
    const names = res.tools.map((t) => t.name);
    expect(res.capInfo).not.toBeNull();
    expect(res.capInfo!.cap).toBe(28);
    expect(names.length).toBeLessThanOrEqual(28);
    expect(names).not.toContain('cf__deploy_worker'); // custom tier dies first
    expect(names).not.toContain('git_commit'); // then admin-cold
    for (const n of NEVER_TRIM) {
      if (![...BOOTSTRAP_SET, ...NAVIGATE_SET].includes(n)) continue;
      expect(names, `NEVER_TRIM tool ${n} must survive the default cap`).toContain(n);
    }
  });

  it('keeps the minimal edit pair when a large plugin catalog exhausts the cap', () => {
    const args = makeArgs('glm-5.2');
    const baseTools = args.registry.list();
    const pluginNoise = Array.from({ length: 80 }, (_, index) => named(`plugin_noise_${index}`));
    const result = buildTools({
      ...args,
      registry: { list: () => [...baseTools, ...pluginNoise] } as unknown as ToolRegistry,
      activeTiers: new Set<ToolTier>(['bootstrap', 'navigate']),
    });
    const names = result.tools.map((tool) => tool.name);

    expect(result.capInfo?.cap).toBe(28);
    expect(names).toContain('edit_file');
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
  });

  it('ignores the retired tool-cap env switch and keeps the product cap', () => {
    process.env.CODER_TOOL_CAP_DEFAULT = '0';
    const res = buildTools(makeArgs('claude-opus-4-7'));
    expect(res.capInfo?.cap).toBe(28);
    expect(res.tools).toHaveLength(28);
  });

  it('subagents/tests (activeTiers null) are exempt from the default cap', () => {
    const res = buildTools({ ...makeArgs('claude-opus-4-7'), activeTiers: null });
    expect(res.capInfo).toBeNull();
    expect(res.tools.map((t) => t.name)).toContain('cf__deploy_worker');
  });

  it('is deterministic: two runs produce byte-identical tool lists', () => {
    const a = JSON.stringify(buildTools(makeArgs('glm-4.5-flash')).tools);
    const b = JSON.stringify(buildTools(makeArgs('glm-4.5-flash')).tools);
    expect(a).toBe(b);
  });

  it('ignores the retired trim kill switch and keeps priority selection', () => {
    process.env.CODER_PRIORITY_TRIM_DISABLE = '1';
    const names = buildTools(makeArgs('glm-4.5-flash')).tools.map((t) => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('read_file');
    expect(names).not.toContain('create_file');
  });

  it('keeps a surgical Company loop instead of the complete master tier', () => {
    const companyEssentials = [
      'post_to_board',
      'read_board',
      'set_agent_status',
      'write_shared_file',
      'read_shared_file',
      'list_shared_files',
    ];
    const catalog = [
      ...BOOTSTRAP_SET,
      ...MASTER_TOOLS,
      ...companyEssentials,
    ].map(named);
    const result = buildTools({
      registry: { list: () => catalog } as unknown as ToolRegistry,
      activeTiers: new Set<ToolTier>(['bootstrap', 'company', 'master']),
      toolContext: {
        cwd: tmpdir(),
        projectName: 'master-test',
        companyContext: { isMaster: true },
      } as unknown as ToolContext,
      provider: { name: 'zai', model: 'glm-4.5-flash' } as unknown as ChatProvider,
    });
    const names = result.tools.map((tool) => tool.name);
    for (const essential of [
      'spawn_subordinate_agent',
      'wait_for_subordinates',
      'list_subordinates',
      'kanban_plan_graph',
      'kanban_list_cards',
      'kanban_move_card',
      'write_shared_file',
      'read_shared_file',
      'list_shared_files',
    ]) {
      expect(names, `essential Company tool ${essential} must survive`).toContain(essential);
      expect(result.protectedToolNames.has(essential), essential).toBe(true);
    }
    expect(names).toHaveLength(28);
    expect(result.protectedToolNames.has('set_agent_status')).toBe(false);
  });

  it('keeps the shared Drive available to compact Company subordinates', () => {
    const subordinateEssentials = [
      'post_to_board',
      'read_board',
      'set_agent_status',
      'write_shared_file',
      'read_shared_file',
      'list_shared_files',
      'ask_master',
      'submit_plan_to_master',
      'submit_tasks_to_master',
      'kanban_read_my_card',
      'kanban_post_comment',
      'kanban_update_objectives',
      'kanban_move_to_review',
    ];
    const catalog = [
      ...BOOTSTRAP_SET,
      ...NAVIGATE_SET,
      ...MASTER_TOOLS,
      ...subordinateEssentials,
    ].map(named);
    const result = buildTools({
      registry: { list: () => catalog } as unknown as ToolRegistry,
      activeTiers: new Set<ToolTier>(['bootstrap', 'navigate', 'company']),
      toolContext: {
        cwd: tmpdir(),
        projectName: 'architect-test',
        companyContext: { isMaster: false },
      } as unknown as ToolContext,
      provider: { name: 'zai', model: 'glm-4.5' } as unknown as ChatProvider,
    });
    const names = result.tools.map((tool) => tool.name);
    for (const essential of [
      'post_to_board',
      'read_board',
      'write_shared_file',
      'read_shared_file',
      'list_shared_files',
      'ask_master',
    ]) {
      expect(names, `essential subordinate tool ${essential} must survive`).toContain(essential);
      expect(result.protectedToolNames.has(essential), essential).toBe(true);
    }
    expect(names).toHaveLength(28);
  });

  it('keeps complete active specialist capabilities instead of trimming role identity', () => {
    const activeTiers = new Set<ToolTier>([
      'bootstrap', 'api', 'app', 'db', 'diagram', 'qa',
      'browser',
    ]);
    const catalog = [...BOOTSTRAP_SET, ...ROLE_CAPABILITY_FLOOR].map(named);
    const result = buildTools({
      registry: { list: () => catalog } as unknown as ToolRegistry,
      activeTiers,
      toolContext: { cwd: tmpdir(), projectName: 'specialist-test' } as unknown as ToolContext,
      provider: { name: 'zai', model: 'glm-4.5-flash' } as unknown as ChatProvider,
    });
    const names = result.tools.map((tool) => tool.name);
    for (const capabilityTool of ROLE_CAPABILITY_FLOOR) {
      expect(names, `capability tool ${capabilityTool} must survive`).toContain(capabilityTool);
      expect(result.protectedToolNames.has(capabilityTool), capabilityTool).toBe(true);
    }
    expect(names.length).toBeGreaterThan(32);
  });
});

describe('buildTools — pinned tools', () => {
  it('a tier-hidden pinned tool joins the visible list', () => {
    const args = { ...makeArgs('claude-opus-4-7'), activeTiers: new Set<ToolTier>(['bootstrap']) };
    expect(buildTools(args).tools.map((t) => t.name)).not.toContain('git_commit');
    const pinned = buildTools({ ...args, pinnedTools: new Set(['git_commit']) });
    expect(pinned.tools.map((t) => t.name)).toContain('git_commit');
  });

  it('a pinned tool survives the model cap (protected bucket)', () => {
    const res = buildTools({ ...makeArgs('glm-4.5-flash'), pinnedTools: new Set(['git_commit']) });
    expect(res.tools.map((t) => t.name)).toContain('git_commit');
    expect(res.tools.length).toBeLessThanOrEqual(29); // cap 28 + at most the pin overflow
  });

  it('uses dynamic pins as a recency-ordered swap window without overflowing the cap', () => {
    const dynamicNames = ['ext_old', 'ext_warm', 'ext_new'];
    const catalog = [
      named('find_tools'),
      named('code_exec'),
      named('ordinary_a'),
      named('ordinary_b'),
      ...dynamicNames.map(named),
    ];
    const tierMap = new Map<string, ToolTier>(
      dynamicNames.map((name) => [name, 'unity' as ToolTier]),
    );
    const result = buildTools({
      registry: { list: () => catalog } as unknown as ToolRegistry,
      activeTiers: new Set<ToolTier>(['bootstrap']),
      externalToolTiers: tierMap,
      pinnedTools: new Set(dynamicNames), // insertion order: old → new
      sessionToolCap: 4,
      toolContext: { cwd: tmpdir(), projectName: 'pin-window' } as unknown as ToolContext,
      provider: { name: 'zai', model: 'claude-opus-4-7' } as unknown as ChatProvider,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      'code_exec', 'ext_new', 'ext_warm', 'find_tools',
    ]);
    expect(result.tools).toHaveLength(4);
    expect(result.protectedToolNames.has('ext_old')).toBe(false);
  });

  it('a disabled tool can never re-enter via a pin', () => {
    const args = {
      ...makeArgs('claude-opus-4-7'),
      activeTiers: new Set<ToolTier>(['bootstrap']),
      sessionDisabledTools: new Set(['git_commit']),
      pinnedTools: new Set(['git_commit']),
    };
    expect(buildTools(args).tools.map((t) => t.name)).not.toContain('git_commit');
  });

  it('pin union keeps the alphabetical presentation invariant', () => {
    const names = buildTools({
      ...makeArgs('claude-opus-4-7'),
      activeTiers: new Set<ToolTier>(['bootstrap']),
      pinnedTools: new Set(['git_commit', 'preview_open']),
    }).tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('buildTools — plugin runtime tiers', () => {
  it('keeps plugin tools out of bootstrap until their own tier is active', () => {
    const pluginTool = named('plugin__cloudflare__cf_deploy');
    const registry = { list: () => [named('mcp__read_file'), pluginTool] } as unknown as ToolRegistry;
    const tierMap = new Map<string, ToolTier>([
      [pluginTool.name, 'plugin:cloudflare'],
    ]);
    const base = {
      registry,
      externalToolTiers: tierMap,
      toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
      provider: { name: 'zai', model: 'claude-opus-4-7' } as unknown as ChatProvider,
    };

    expect(buildTools({ ...base, activeTiers: new Set<ToolTier>(['bootstrap']) }).tools.map((t) => t.name))
      .toEqual(['mcp__read_file']);
    expect(buildTools({
      ...base,
      activeTiers: new Set<ToolTier>(['bootstrap', 'plugin:cloudflare']),
    }).tools.map((t) => t.name)).toEqual(['mcp__read_file', 'plugin__cloudflare__cf_deploy']);
  });
});

describe('buildTools — session tool cap (task preflight)', () => {
  it('caps a large-catalog model at the session cap and reports it in capInfo', () => {
    const res = buildTools({ ...makeArgs('claude-opus-4-7'), sessionToolCap: 40 });
    expect(res.capInfo).not.toBeNull();
    expect(res.capInfo!.cap).toBe(40);
    expect(res.tools.length).toBeLessThanOrEqual(40);
    // Cold tiers die first under the session cap, hot core survives.
    expect(res.tools.map((t) => t.name)).toContain('edit_file');
    expect(res.tools.map((t) => t.name)).not.toContain('cf__deploy_worker');
  });

  it('the model cap wins when smaller than the session cap', () => {
    const res = buildTools({ ...makeArgs('glm-4.5-flash'), sessionToolCap: 100 });
    expect(res.capInfo!.cap).toBe(32);
  });

  it('12 preflight pins all survive a 32-tool model cap', () => {
    const pins = [
      'write_file', 'edit_file', 'multi_edit', 'create_file', 'run_command', 'get_diagnostics',
      'git_status', 'git_diff', 'git_log', 'web_fetch', 'mcp__find_references', 'git_commit',
    ];
    const names = buildTools({
      ...makeArgs('glm-4.5-flash'),
      pinnedTools: new Set(pins),
      requiredPinnedTools: new Set(pins),
    }).tools.map((t) => t.name);
    for (const pin of pins) {
      expect(names, `preflight pin ${pin} must survive the cap`).toContain(pin);
    }
  });

  it('ships terse descriptions for every tool under an effective cap ≤ 64', () => {
    const tools = buildTools({ ...makeArgs('claude-opus-4-7'), sessionToolCap: 40 }).tools;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    expect(byName.get('mcp__search')).toBe('mcp__search description.');
    expect(byName.get('read_file')).toBe('read_file description.');
  });

  it('an explicit session cap ABOVE 64 keeps full descriptions (not a compact catalog)', () => {
    const tools = buildTools({ ...makeArgs('claude-opus-4-7'), sessionToolCap: 80 }).tools;
    expect(tools.find((t) => t.name === 'mcp__search')?.description).toBe(
      `mcp__search description. ${TAIL}`,
    );
  });
});

describe('buildTools — terse descriptions for compact-catalog models', () => {
  it('compact model (cap ≤ 64): all visible tools use the concise contract', () => {
    const tools = buildTools(makeArgs('glm-4.5-flash')).tools;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    // Hot survivor outside the core → first sentence only.
    expect(byName.get('mcp__search')).toBe('mcp__search description.');
    expect(byName.get('read_file')).toBe('read_file description.');
    expect(byName.get('code_exec')).toBe('code_exec description.');
  });

  it('retired tool-cap env cannot restore the large legacy catalog', () => {
    process.env.CODER_TOOL_CAP_DEFAULT = '0';
    const tools = buildTools(makeArgs('claude-opus-4-7')).tools;
    expect(tools).toHaveLength(28);
    expect(tools.find((t) => t.name === 'mcp__search')?.description)
      .toBe('mcp__search description.');
  });
});

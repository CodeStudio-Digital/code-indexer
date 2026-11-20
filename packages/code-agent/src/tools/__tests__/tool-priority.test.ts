/**
 * buildTools contracts that survived the removal of the priority-trim
 * projection (selectUnderCap/NEVER_TRIM/terse/runtime pins): mode gates,
 * presentation order, determinism, plugin tiers, session cap and specialist
 * floors, now exercised on the stable workflow projection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { ROLE_CAPABILITY_FLOOR } from '../tool-priority.js';
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
  'write_file', 'edit_file', 'manage_path', 'run_command', 'get_diagnostics',
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

describe('buildTools — priority trim at a weak-model cap', () => {
  it('does not expose or re-pin submit_plan for a Build-mode runner', () => {
    const base = makeArgs('glm-4.5-flash');
    const tools = buildTools({
      ...base,
      
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
      
      toolContext: {
        ...base.toolContext,
        runner: { planMode: false, specMode: true },
      } as unknown as ToolContext,
    }).tools.map((tool) => tool.name);

    expect(names).not.toContain('submit_plan');
    expect(names).toContain('submit_spec');
  });

  it('emits a globally alphabetical list (presentation invariant)', () => {
    const names = buildTools(makeArgs('glm-4.5-flash')).tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
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
      'write_file', 'edit_file', 'manage_path', 'run_command', 'get_diagnostics',
      'git_status', 'git_diff', 'git_log', 'web_fetch', 'mcp__find_references', 'git_commit',
    ];
    const names = buildTools({
      ...makeArgs('glm-4.5-flash'),
      requiredPinnedTools: new Set(pins),
    }).tools.map((t) => t.name);
    for (const pin of pins) {
      expect(names, `preflight pin ${pin} must survive the cap`).toContain(pin);
    }
  });

  it('keeps full descriptions at any session cap (no terse projection)', () => {
    const tools = buildTools({ ...makeArgs('claude-opus-4-7'), sessionToolCap: 80 }).tools;
    expect(tools.find((t) => t.name === 'mcp__search')?.description).toBe(
      `mcp__search description. ${TAIL}`,
    );
  });
});


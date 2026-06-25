/**
 * Tests for priority-based catalog trimming (tool-priority.ts + buildTools).
 *
 * Contract under test:
 *   - selectUnderCap is deterministic (input order never changes the result)
 *   - drop order: custom tier → preview → admin → navigate-cold →
 *     bootstrap-cold → hot tails last
 *   - NEVER_TRIM tools always survive the model cap
 *   - buildTools output stays globally alphabetical (prompt-cache invariant)
 *   - CODER_PRIORITY_TRIM_DISABLE=1 restores the legacy alphabetical tail-cut
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { NEVER_TRIM, selectUnderCap } from '../tool-priority.js';
import { buildTools } from '../../core/runner/assembly/tools.js';
import type { ToolRegistry } from '../../core/registry.js';
import type { ToolContext } from '../../core/tool.js';
import type { ChatProvider } from '../../providers/adapter.js';
import type { ToolTier } from '../tiers.js';
import { getToolTier } from '../tiers.js';

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
  'find_tools', 'ask_user', 'submit_plan', 'task_list', 'submit_tasks', 'update_goal', 'create_goal',
  'save_note', 'recall_investigations', 'get_tool_output', 'invoke_skill',
  'rag_search_docs', 'rag_read_doc', 'get_skills_list', 'get_skill_content',
  'list_skill_namespaces', 'mcp__get_project_pulse', 'mcp__search', 'mcp__grep_code',
  'mcp__get_file_skeleton', 'mcp__read_file', 'mcp__list_directory', 'view_image',
  'submit_spec', 'request_review', 'self_review', 'spawn_agent', 'execute_tasks', 'update_todo',
];
const NAVIGATE_SET = [
  'write_file', 'edit_file', 'multi_edit', 'create_file', 'run_command', 'get_diagnostics',
  'git_status', 'git_diff', 'git_log', 'web_fetch', 'web_search', 'task_complete',
  'list_tasks', 'read_plan', 'list_notes', 'get_goal', 'mcp__find_references', 'mcp__save_memory',
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
    toolContext: { cwd: tmpdir(), projectName: 'test' } as unknown as ToolContext,
    provider: { name: 'zai', model } as unknown as ChatProvider,
  };
}

afterEach(() => {
  delete process.env.CODER_PRIORITY_TRIM_DISABLE;
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
  it('caps at 32 for glm-4.5-flash, keeps NEVER_TRIM + hot core, drops cold tiers', () => {
    const res = buildTools(makeArgs('glm-4.5-flash'));
    const names = res.tools.map((t) => t.name);

    expect(res.capInfo).not.toBeNull();
    expect(res.capInfo!.cap).toBe(32);
    expect(names.length).toBeLessThanOrEqual(32);

    // Every NEVER_TRIM member present in the registry survives.
    for (const n of NEVER_TRIM) {
      if (![...BOOTSTRAP_SET, ...NAVIGATE_SET].includes(n)) continue;
      expect(names, `NEVER_TRIM tool ${n} must survive`).toContain(n);
    }
    // Regression: task_list is the ONE always-on task tool (todos+tasks merge);
    // the cap must never drop it, even at the most aggressive 32-tool cap.
    expect(names).toContain('task_list');
    // Hot working core survives; cold tiers die first.
    expect(names).toContain('write_file');
    expect(names).toContain('edit_file');
    expect(names).toContain('mcp__search');
    expect(names).not.toContain('cf__deploy_worker');
    expect(names).not.toContain('preview_open');
    expect(names).not.toContain('git_commit');
    expect(names).not.toContain('list_tasks'); // navigate-cold (Phase B)
  });

  it('emits a globally alphabetical list (presentation invariant)', () => {
    const names = buildTools(makeArgs('glm-4.5-flash')).tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('does not trim for large-catalog models (capInfo null)', () => {
    const res = buildTools(makeArgs('claude-opus-4-7'));
    expect(res.capInfo).toBeNull();
    expect(res.tools.map((t) => t.name)).toContain('git_commit');
    expect(res.tools.map((t) => t.name)).toContain('cf__deploy_worker');
  });

  it('is deterministic: two runs produce byte-identical tool lists', () => {
    const a = JSON.stringify(buildTools(makeArgs('glm-4.5-flash')).tools);
    const b = JSON.stringify(buildTools(makeArgs('glm-4.5-flash')).tools);
    expect(a).toBe(b);
  });

  it('CODER_PRIORITY_TRIM_DISABLE=1 restores the legacy alphabetical tail-cut', () => {
    process.env.CODER_PRIORITY_TRIM_DISABLE = '1';
    const names = buildTools(makeArgs('glm-4.5-flash')).tools.map((t) => t.name);
    // Legacy cut is alphabetical over the non-protected bucket: 'write_file'
    // sits at the tail and dies, while alphabetically-early cold tools survive.
    expect(names).not.toContain('write_file');
    expect(names).toContain('create_file');
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
    expect(res.tools.length).toBeLessThanOrEqual(33); // cap 32 + at most the pin overflow
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
    }).tools.map((t) => t.name);
    for (const pin of pins) {
      expect(names, `preflight pin ${pin} must survive the cap`).toContain(pin);
    }
  });

  it('session cap does NOT flip descriptions to terse on a large model', () => {
    const tools = buildTools({ ...makeArgs('claude-opus-4-7'), sessionToolCap: 40 }).tools;
    expect(tools.find((t) => t.name === 'mcp__search')?.description).toBe(
      `mcp__search description. ${TAIL}`,
    );
  });
});

describe('buildTools — terse descriptions for compact-catalog models', () => {
  it('compact model (cap ≤ 64): non-core tools terse, NEVER_TRIM core keeps full text', () => {
    const tools = buildTools(makeArgs('glm-4.5-flash')).tools;
    const byName = new Map(tools.map((t) => [t.name, t.description]));
    // Hot survivor outside the core → first sentence only.
    expect(byName.get('mcp__search')).toBe('mcp__search description.');
    // NEVER_TRIM core → full USE/DON'T text preserved.
    expect(byName.get('read_file')).toBe(`read_file description. ${TAIL}`);
    expect(byName.get('code_exec')).toBe(`code_exec description. ${TAIL}`);
  });

  it('large-catalog model with navigate active keeps full descriptions (byte parity)', () => {
    const tools = buildTools(makeArgs('claude-opus-4-7')).tools;
    expect(tools.find((t) => t.name === 'mcp__search')?.description).toBe(
      `mcp__search description. ${TAIL}`,
    );
  });
});

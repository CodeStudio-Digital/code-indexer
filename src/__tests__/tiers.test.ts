import { describe, it, expect } from 'vitest';
import {
  getToolTier,
  profileToTiers,
  filterByTiers,
  inferProfileFromMessage,
  TIER_COUNTS,
  BOOTSTRAP_TOOLS,
  NAVIGATE_TOOLS,
  type ToolTier,
} from '@mcp/code-agent/tools/tiers.js';

describe('tool tiers', () => {
  it('bootstrap tier contains exactly the expected tools', () => {
    // Goal telemetry was retired; task_list remains the active task surface.
    expect(TIER_COUNTS.bootstrap).toBe(49);
    expect(BOOTSTRAP_TOOLS.has('create_goal')).toBe(false);
    expect(BOOTSTRAP_TOOLS.has('update_goal')).toBe(false);
    expect(BOOTSTRAP_TOOLS.has('task_list')).toBe(true);
  });

  it('navigate tier contains the expected tools', () => {
    // get_goal was retired; all shell continuation/observation tools stay here.
    expect(TIER_COUNTS.navigate).toBe(59);
    expect(NAVIGATE_TOOLS.has('get_goal')).toBe(false);
    for (const name of ['exec_command', 'write_stdin', 'poll_session', 'stop_session', 'read_process_output']) {
      expect(NAVIGATE_TOOLS.has(name)).toBe(true);
    }
  });

  it('admin tier contains the expected tools', () => {
    expect(TIER_COUNTS.admin).toBe(9);
  });

  it('classifies bootstrap tools correctly', () => {
    expect(getToolTier('mcp__read_file')).toBe('bootstrap');
    expect(getToolTier('mcp__get_project_pulse')).toBe('bootstrap');
    expect(getToolTier('ask_user')).toBe('bootstrap');
    expect(getToolTier('expand_toolset')).toBe('bootstrap');
    expect(getToolTier('submit_plan')).toBe('bootstrap');
    expect(getToolTier('glob')).toBe('bootstrap');
    // NOTE: `todo_write` is a NAVIGATE-tier back-compat alias (the bootstrap
    // task tool is `task_list`), so it is intentionally not asserted here.
  });

  it('classifies navigate tools correctly', () => {
    expect(getToolTier('read_file')).toBe('navigate');
    expect(getToolTier('write_file')).toBe('navigate');
    expect(getToolTier('edit_file')).toBe('navigate');
    expect(getToolTier('multi_edit')).toBe('navigate');
    expect(getToolTier('run_command')).toBe('navigate');
    expect(getToolTier('git_status')).toBe('navigate');
    expect(getToolTier('mcp__find_references')).toBe('navigate');
    expect(getToolTier('mcp__prepare_edit')).toBe('navigate');
    expect(getToolTier('web_fetch')).toBe('navigate');
    expect(getToolTier('web_search')).toBe('navigate');
  });

  it('classifies admin tools correctly', () => {
    expect(getToolTier('git_commit')).toBe('admin');
    expect(getToolTier('git_add')).toBe('admin');
    expect(getToolTier('mcp__index_project')).toBe('admin');
    expect(getToolTier('mcp__get_costs')).toBe('admin');
    expect(getToolTier('enter_worktree')).toBe('admin');
    expect(getToolTier('exit_worktree')).toBe('admin');
  });

  it('treats unknown tools as bootstrap (safe default)', () => {
    expect(getToolTier('some_new_tool')).toBe('bootstrap');
  });

  it('profileToTiers expands profiles correctly', () => {
    expect(profileToTiers('bootstrap')).toEqual(new Set<ToolTier>(['bootstrap']));
    expect(profileToTiers('navigate')).toEqual(new Set<ToolTier>(['bootstrap', 'navigate']));
    expect(profileToTiers('full')).toEqual(new Set<ToolTier>(['bootstrap', 'navigate', 'admin']));
  });

  it('filterByTiers only returns tools whose tier is active', () => {
    const tools = [
      { name: 'read_file' },
      { name: 'write_file' },
      { name: 'git_commit' },
      { name: 'mcp__get_project_pulse' },
      { name: 'mcp__find_references' },
      { name: 'mcp__index_project' },
    ];
    const bootstrap = filterByTiers(tools, profileToTiers('bootstrap'));
    expect(bootstrap.map((t) => t.name).sort()).toEqual(['mcp__get_project_pulse']);

    const navigate = filterByTiers(tools, profileToTiers('navigate'));
    expect(navigate.map((t) => t.name).sort()).toEqual([
      'mcp__find_references',
      'mcp__get_project_pulse',
      'read_file',
      'write_file',
    ]);

    const full = filterByTiers(tools, profileToTiers('full'));
    expect(full).toHaveLength(6);
  });

  it('filterByTiers preserves input order (for cache stability)', () => {
    const tools = [
      { name: 'mcp__get_project_pulse' },
      { name: 'write_file' },
      { name: 'read_file' },
      { name: 'git_commit' },
    ];
    const result = filterByTiers(tools, profileToTiers('navigate'));
    // Order from the input is preserved — write_file stays between
    // get_project_pulse and read_file even though alphabetical sort would
    // rearrange them.
    expect(result.map((t) => t.name)).toEqual(['mcp__get_project_pulse', 'write_file', 'read_file']);
  });

  it('inferProfileFromMessage routes git operations to full', () => {
    expect(inferProfileFromMessage('commit these changes')).toBe('full');
    expect(inferProfileFromMessage('push to main')).toBe('full');
    expect(inferProfileFromMessage('create a new branch')).toBe('full');
  });

  it('inferProfileFromMessage routes edit/implement requests to navigate', () => {
    expect(inferProfileFromMessage('refactor the auth module')).toBe('navigate');
    expect(inferProfileFromMessage('implemente um teste')).toBe('navigate');
    expect(inferProfileFromMessage('fix the bug in runner.ts')).toBe('navigate');
    expect(inferProfileFromMessage('adicione logs ao handler')).toBe('navigate');
  });

  it('inferProfileFromMessage routes exploratory questions to bootstrap', () => {
    expect(inferProfileFromMessage('how does the runner work?')).toBe('bootstrap');
    expect(inferProfileFromMessage('explique o tier system')).toBe('bootstrap');
    expect(inferProfileFromMessage('onde fica a configuração?')).toBe('bootstrap');
  });
});

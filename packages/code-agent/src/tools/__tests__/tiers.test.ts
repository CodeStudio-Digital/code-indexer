/**
 * Tier placement of the persistent-shell session trio.
 *
 * Regression guard for the write_stdin misfire loop: exec_command /
 * write_stdin / list_sessions used to fall through getToolTier's `bootstrap`
 * fallback, exposing write_stdin on turn 1 while write_file stayed gated
 * behind navigate. They now live in navigate alongside run_command/write_file.
 */
import { describe, expect, it } from 'vitest';
import {
  getToolTier,
  profileToTiers,
  filterByTiers,
  getAllKnownToolsMeta,
  BOOTSTRAP_TOOLS,
} from '@mcp/code-agent/tools/tiers.js';
import { todoTools } from '@mcp/code-agent/tools/todo.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';

describe('tool tiers — persistent-shell session trio', () => {
  it('places exec_command / write_stdin / list_sessions in navigate, not bootstrap', () => {
    expect(getToolTier('exec_command')).toBe('navigate');
    expect(getToolTier('write_stdin')).toBe('navigate');
    expect(getToolTier('list_sessions')).toBe('navigate');
    // Co-located with the everyday file/command tools.
    expect(getToolTier('write_file')).toBe('navigate');
    expect(getToolTier('run_command')).toBe('navigate');
  });

  it('hides the trio and native read_file from bootstrap while keeping the MCP read surface', () => {
    const bootstrap = profileToTiers('bootstrap');
    const tools = [
      { name: 'read_file' },
      { name: 'mcp__read_file' },
      { name: 'write_stdin' },
      { name: 'exec_command' },
      { name: 'list_sessions' },
      { name: 'write_file' },
    ];
    const visible = filterByTiers(tools, bootstrap).map((t) => t.name);
    expect(visible).toEqual(['mcp__read_file']);
  });

  it('reveals the trio once navigate is active', () => {
    const navigate = profileToTiers('navigate');
    const tools = [{ name: 'write_stdin' }, { name: 'exec_command' }, { name: 'list_sessions' }, { name: 'write_file' }];
    const visible = filterByTiers(tools, navigate).map((t) => t.name);
    expect(visible).toEqual(['write_stdin', 'exec_command', 'list_sessions', 'write_file']);
  });
});

describe('tier contract — always-on state tools are explicitly tiered', () => {
  // todoTools + goalTools register UNCONDITIONALLY for every session
  // (index.ts:292,295). A member missing from every explicit tier set would
  // ship on turn 1 ONLY via getToolTier's bootstrap fallback — the silent
  // gotcha that hid update_todo / create_goal / get_goal / update_goal for
  // months. This locks them in so a future add to either module can't quietly
  // ride the fallback.
  const explicit = new Set(getAllKnownToolsMeta().map((t) => t.name));
  const alwaysOnStateTools = [...todoTools, ...goalTools].map((t) => t.name);

  it.each(alwaysOnStateTools)('%s is in an explicit tier set (no silent fallback)', (name) => {
    expect(explicit.has(name)).toBe(true);
  });

  it('the P1-promoted orphans live explicitly in bootstrap', () => {
    // get_goal demoted to navigate in Phase B (12 calls / 12k turns); create_goal
    // + update_goal stay in bootstrap so a goal can be set AND cleared without a
    // tier unlock (the goal-gate hides create_goal by name on in-progress).
    for (const name of ['create_goal', 'update_goal']) {
      expect(BOOTSTRAP_TOOLS.has(name)).toBe(true);
    }
    expect(getToolTier('get_goal')).toBe('navigate');
  });

  it('task_list is the one bootstrap task tool; todo_write/update_todo/submit_tasks are navigate aliases', () => {
    // Merge of todos+tasks: only task_list rides the turn-1 surface. The legacy
    // names stay registered (back-compat aliases) but demoted to navigate so the
    // model sees ONE task tool — killing the two-tool selection fork.
    expect(BOOTSTRAP_TOOLS.has('task_list')).toBe(true);
    for (const name of ['todo_write', 'update_todo', 'submit_tasks']) {
      expect(BOOTSTRAP_TOOLS.has(name)).toBe(false);
      expect(getToolTier(name)).toBe('navigate');
    }
  });
});

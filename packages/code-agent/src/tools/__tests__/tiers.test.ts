/**
 * Tier placement of the persistent-shell session trio.
 *
 * Regression guard for the write_stdin misfire loop: exec_command /
 * write_stdin / list_sessions used to fall through getToolTier's `bootstrap`
 * fallback, exposing write_stdin on turn 1 while write_file stayed gated
 * behind navigate. They now live in navigate alongside run_command/write_file.
 */
import { describe, expect, it } from 'vitest';
import { getToolTier, profileToTiers, filterByTiers } from '@mcp/code-agent/tools/tiers.js';

describe('tool tiers — persistent-shell session trio', () => {
  it('places exec_command / write_stdin / list_sessions in navigate, not bootstrap', () => {
    expect(getToolTier('exec_command')).toBe('navigate');
    expect(getToolTier('write_stdin')).toBe('navigate');
    expect(getToolTier('list_sessions')).toBe('navigate');
    // Co-located with the everyday file/command tools.
    expect(getToolTier('write_file')).toBe('navigate');
    expect(getToolTier('run_command')).toBe('navigate');
  });

  it('hides the trio from a bootstrap-profile session but keeps read tools', () => {
    const bootstrap = profileToTiers('bootstrap');
    const tools = [
      { name: 'read_file' },
      { name: 'write_stdin' },
      { name: 'exec_command' },
      { name: 'list_sessions' },
      { name: 'write_file' },
    ];
    const visible = filterByTiers(tools, bootstrap).map((t) => t.name);
    expect(visible).toEqual(['read_file']);
  });

  it('reveals the trio once navigate is active', () => {
    const navigate = profileToTiers('navigate');
    const tools = [{ name: 'write_stdin' }, { name: 'exec_command' }, { name: 'list_sessions' }, { name: 'write_file' }];
    const visible = filterByTiers(tools, navigate).map((t) => t.name);
    expect(visible).toEqual(['write_stdin', 'exec_command', 'list_sessions', 'write_file']);
  });
});

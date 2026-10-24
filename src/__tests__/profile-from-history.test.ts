import { describe, it, expect } from 'vitest';
import { inferProfileFromHistory } from '@mcp/code-agent/tools/tiers.js';

/**
 * On session resume the runner used to default to `profile: 'full'` — paying
 * for every navigate/admin tool description on every turn even when the
 * conversation only ever called read_file. inferProfileFromHistory scans the
 * tool_use blocks in the resumed history and picks the smallest profile that
 * still covers what was used.
 */

describe('inferProfileFromHistory', () => {
  it('returns bootstrap when only bootstrap tools were used', () => {
    expect(
      inferProfileFromHistory(['mcp__read_file', 'list_directory', 'ask_user']),
    ).toBe('bootstrap');
  });

  it('returns navigate when any navigate-tier tool was used', () => {
    expect(
      inferProfileFromHistory(['read_file', 'edit_file', 'list_directory']),
    ).toBe('navigate');
  });

  it('returns full when any admin-tier tool was used (overrides navigate)', () => {
    expect(
      inferProfileFromHistory(['read_file', 'edit_file', 'git_commit']),
    ).toBe('full');
  });

  it('returns bootstrap on an empty history', () => {
    expect(inferProfileFromHistory([])).toBe('bootstrap');
  });

  it('treats unknown / external tool names as bootstrap by default', () => {
    expect(
      inferProfileFromHistory(['ext_my_server__do_thing', 'mcp__read_file']),
    ).toBe('bootstrap');
  });

  it('honors runtime tier overrides for external MCP tools', () => {
    const overrides = new Map<string, string>([
      ['ext_my_server__deploy', 'admin'],
    ]);
    expect(
      inferProfileFromHistory(['read_file', 'ext_my_server__deploy'], overrides),
    ).toBe('full');
  });

  it('exits early as soon as it sees an admin tool — order does not matter', () => {
    expect(
      inferProfileFromHistory(['git_commit', 'read_file', 'edit_file']),
    ).toBe('full');
    expect(
      inferProfileFromHistory(['read_file', 'edit_file', 'git_commit']),
    ).toBe('full');
  });
});

/**
 * Subagent allowlist leanness (Phase D).
 *
 * Regression guard: READ_WRITE_FILTER used to admit the ENTIRE
 * EXPLORE_ALLOWLIST (~41 read tools) on top of IMPLEMENT_ALLOWLIST, so an
 * implement subagent saw ~50 tools when ~21 suffice. The reads an implementer
 * actually needs are now listed directly in IMPLEMENT_ALLOWLIST; explore-only
 * tools (web search, deep navigation, project overview) must NOT leak in.
 */
import { describe, expect, it } from 'vitest';
import {
  READ_ONLY_FILTER,
  READ_WRITE_FILTER,
  EXPLORE_ALLOWLIST,
  IMPLEMENT_ALLOWLIST,
  checkPathScopeForTool,
} from '@mcp/code-agent/tools/implement-subagent.js';

const tool = (name: string, source: 'native' | 'mcp' | 'mcp_external' = 'native', mutates?: boolean) =>
  ({ name, source, mutates }) as never;

describe('implement subagent — READ_WRITE_FILTER is lean', () => {
  it('admits the implement essentials (edit + verify + scoped reads)', () => {
    for (const n of [
      'edit_file', 'multi_edit', 'write_file', 'create_file', 'run_command',
      'read_file', 'glob', 'get_diagnostics', 'git_status', 'mcp__read_file',
    ]) {
      expect(READ_WRITE_FILTER(tool(n)), n).toBe(true);
    }
  });

  it('does NOT inherit explore-only reads', () => {
    const exploreOnly = ['web_search', 'web_fetch', 'mcp__get_recently_modified_files',
      'mcp__trace_usage', 'mcp__get_project_overview', 'mcp__search'];
    for (const n of exploreOnly) {
      // these live in EXPLORE_ALLOWLIST but not IMPLEMENT_ALLOWLIST — they must
      // NOT pass the implement filter (the bug was blanket EXPLORE inheritance).
      expect(EXPLORE_ALLOWLIST.has(n) && !IMPLEMENT_ALLOWLIST.has(n), `precondition: ${n}`).toBe(true);
      expect(READ_WRITE_FILTER(tool(n)), n).toBe(false);
    }
  });

  it('still admits external MCP tools (implementers act via MCP)', () => {
    expect(READ_WRITE_FILTER(tool('ext_github__create_pr', 'mcp_external', true))).toBe(true);
    expect(READ_WRITE_FILTER(tool('ext_x__read', 'mcp_external', false))).toBe(true);
  });
});

describe('explore subagent — READ_ONLY_FILTER stays read-only', () => {
  it('admits reads, rejects writes/shell', () => {
    expect(READ_ONLY_FILTER(tool('read_file'))).toBe(true);
    expect(READ_ONLY_FILTER(tool('mcp__grep_code'))).toBe(true);
    expect(READ_ONLY_FILTER(tool('write_file'))).toBe(false);
    expect(READ_ONLY_FILTER(tool('run_command'))).toBe(false);
    // non-mutating external MCP is allowed; mutating is not
    expect(READ_ONLY_FILTER(tool('ext_x__read', 'mcp_external', false))).toBe(true);
    expect(READ_ONLY_FILTER(tool('ext_x__write', 'mcp_external', true))).toBe(false);
  });
});

describe('subagent path scope', () => {
  it('records read violations without blocking in warn mode', () => {
    const scoped = checkPathScopeForTool(
      'read_file',
      { path: 'src/other.ts' },
      ['src/owned.ts'],
      'warn',
    );

    expect(scoped.violations).toEqual(['read_file:src/other.ts']);
    expect(scoped.blockedMessage).toBeUndefined();
  });

  it('blocks write violations in enforce-writes mode', () => {
    const scoped = checkPathScopeForTool(
      'edit_file',
      { path: 'src/other.ts' },
      ['src/owned.ts'],
      'enforce-writes',
    );

    expect(scoped.violations).toEqual(['edit_file:src/other.ts']);
    expect(scoped.blockedMessage).toContain('subagent path scope violation');
  });

  it('allows scoped writes in enforce-writes mode', () => {
    const scoped = checkPathScopeForTool(
      'edit_file',
      { path: 'src/owned.ts' },
      ['src/owned.ts'],
      'enforce-writes',
    );

    expect(scoped.violations).toEqual([]);
    expect(scoped.blockedMessage).toBeUndefined();
  });

  it('records run_command scope violations without blocking in enforce-writes mode', () => {
    const scoped = checkPathScopeForTool(
      'run_command',
      { command: 'cd src/other && pnpm test' },
      ['src/owned.ts'],
      'enforce-writes',
    );

    expect(scoped.violations).toEqual(['run_command:src/other']);
    expect(scoped.blockedMessage).toBeUndefined();
  });
});

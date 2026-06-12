/**
 * Closest-match suggestion for unknown tool names + its wiring into the
 * `ToolRegistry.invoke` unknown-tool error. The driving case comes straight
 * from telemetry: a model called `grep_code` when the registered tool is
 * `mcp__grep_code` and got a dead-end "Unknown tool: grep_code".
 */
import { describe, it, expect } from 'vitest';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { suggestToolName } from '../tool-name-suggest.js';
import { ToolRegistry } from '../registry.js';

const KNOWN = [
  'read_file',
  'write_file',
  'edit_file',
  'run_command',
  'mcp__grep_code',
  'mcp__read_file',
  'mcp__oc__list_directory',
  'ext_unity__query_scene',
];

describe('suggestToolName — namespace-blind match (the telemetry case)', () => {
  it('maps grep_code → mcp__grep_code', () => {
    expect(suggestToolName('grep_code', KNOWN)).toBe('mcp__grep_code');
  });

  it('maps a bare name to a server-prefixed tool (list_directory → mcp__oc__list_directory)', () => {
    expect(suggestToolName('list_directory', KNOWN)).toBe('mcp__oc__list_directory');
  });

  it('works in the reverse direction (prefixed call, bare registration)', () => {
    expect(suggestToolName('mcp__run_command', KNOWN)).toBe('run_command');
  });

  it('handles ext_ plugin namespaces', () => {
    expect(suggestToolName('query_scene', KNOWN)).toBe('ext_unity__query_scene');
  });
});

describe('suggestToolName — exact and fuzzy tiers', () => {
  it('prefers a case-insensitive exact match over everything', () => {
    expect(suggestToolName('Read_File', KNOWN)).toBe('read_file');
  });

  it('catches small typos within the Levenshtein band', () => {
    expect(suggestToolName('read_fil', KNOWN)).toBe('read_file');
    expect(suggestToolName('rnu_command', KNOWN)).toBe('run_command');
  });

  it('returns null when nothing is plausibly close', () => {
    expect(suggestToolName('completely_unrelated_xyz', KNOWN)).toBeNull();
    expect(suggestToolName('zz', KNOWN)).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(suggestToolName('', KNOWN)).toBeNull();
    expect(suggestToolName('read_file', [])).toBeNull();
  });

  it('breaks distance ties deterministically (lexicographic smallest)', () => {
    // aab is distance 1 from both aaa and aac → smallest wins, every time.
    expect(suggestToolName('aab', ['aac', 'aaa'])).toBe('aaa');
    expect(suggestToolName('aab', ['aaa', 'aac'])).toBe('aaa');
  });
});

describe('ToolRegistry.invoke — unknown tool error carries the suggestion', () => {
  const ctx = {} as ToolContext;
  const mk = (name: string): CoderTool => ({
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
  });

  it('suggests the close name and omits find_tools when not registered', async () => {
    const reg = new ToolRegistry();
    reg.register(mk('mcp__grep_code'));
    const res = await reg.invoke('grep_code', {}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Unknown tool: grep_code');
    expect(res.content).toContain('Did you mean `mcp__grep_code`?');
    expect(res.content).not.toContain('find_tools');
  });

  it('points at find_tools only when that tool exists in this session', async () => {
    const reg = new ToolRegistry();
    reg.register(mk('find_tools'));
    const res = await reg.invoke('totally_unknown_zzz', {}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Call find_tools to list available tools.');
    expect(res.content).not.toContain('Did you mean');
  });
});

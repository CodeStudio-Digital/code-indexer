/**
 * Silent tool-argument alias normalization.
 *
 * Models habituated to Claude Code's param names (`file_path`, `old_string`,
 * `content`, `command`, `pattern`, …) send them to tools that renamed those
 * params (notably `path`). `normalizeToolArgs` repairs the wrong name against
 * the tool's OWN schema, so it's safe for native + MCP tools and never touches
 * tools that legitimately use a "wrong" name. The fix lives at the single
 * dispatch chokepoint `ToolRegistry.invoke`, so it also covers `code_exec`'s
 * nested tool calls.
 */
import { describe, it, expect } from 'vitest';
import type { CoderTool, JsonSchema, ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  normalizeToolArgs,
  aliasNormalizationEnabled,
  ALIAS_GROUPS,
} from '../tool-arg-aliases.js';
import { ToolRegistry } from '../registry.js';

/** Build a minimal object schema from a list of property names. */
const schema = (...names: string[]): JsonSchema => ({
  type: 'object',
  properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
});

describe('normalizeToolArgs — the core fix', () => {
  it('rewrites file_path → path for a read_file-shaped tool', () => {
    const out = normalizeToolArgs(schema('path', 'start_line'), { file_path: 'a.ts' });
    expect(out).toEqual({ path: 'a.ts' });
    expect('file_path' in out).toBe(false);
  });

  it('does not mutate the input object', () => {
    const args = { file_path: 'a.ts' };
    const out = normalizeToolArgs(schema('path'), args);
    expect(out).toEqual({ path: 'a.ts' });
    expect(args).toEqual({ file_path: 'a.ts' }); // untouched
    expect(out).not.toBe(args);
  });

  it('accepts camelCase / casing variants for path', () => {
    expect(normalizeToolArgs(schema('path'), { filePath: 'a' })).toEqual({ path: 'a' });
    expect(normalizeToolArgs(schema('path'), { fileName: 'a' })).toEqual({ path: 'a' });
    expect(normalizeToolArgs(schema('path'), { filename: 'a' })).toEqual({ path: 'a' });
    expect(normalizeToolArgs(schema('path'), { pathname: 'a' })).toEqual({ path: 'a' });
  });
});

describe('normalizeToolArgs — rule (b): never clobber a real value', () => {
  it('leaves a present canonical untouched and keeps the call a no-op', () => {
    const args = { path: 'real', file_path: 'wrong' };
    const out = normalizeToolArgs(schema('path'), args);
    expect(out).toBe(args); // no rewrite happened → same reference
    expect(out.path).toBe('real');
  });

  it('treats an empty-string canonical as blank and fills it from the alias', () => {
    const out = normalizeToolArgs(schema('path'), { path: '', file_path: 'real.ts' });
    expect(out).toEqual({ path: 'real.ts' });
  });
});

describe('normalizeToolArgs — rule (a): canonical must be a real param', () => {
  it('does nothing when the tool has no such canonical param', () => {
    const args = { file_path: 'a' };
    const out = normalizeToolArgs(schema('foo', 'bar'), args);
    expect(out).toBe(args);
  });
});

describe('normalizeToolArgs — symmetric groups: the declared member is the target', () => {
  it('repairs the REVERSE direction: path → file_path for LSP-shaped tools', () => {
    // The real telemetry gap: lsp_definition declares `file_path`; a model
    // habituated to fs tools sends `path` and used to hard-fail.
    const out = normalizeToolArgs(schema('file_path', 'line', 'column'), {
      path: 'a.ts',
      line: 3,
      column: 1,
    });
    expect(out).toEqual({ file_path: 'a.ts', line: 3, column: 1 });
  });

  it('repairs command → cmd and cwd → workdir for exec_command-shaped tools', () => {
    expect(normalizeToolArgs(schema('cmd', 'workdir'), { command: 'ls' })).toEqual({ cmd: 'ls' });
    expect(normalizeToolArgs(schema('cmd', 'workdir'), { cmd: 'ls', cwd: '/x' })).toEqual({
      cmd: 'ls',
      workdir: '/x',
    });
  });

  it('still repairs the original direction (cmd → command for run_command)', () => {
    expect(normalizeToolArgs(schema('command', 'cwd'), { cmd: 'ls' })).toEqual({ command: 'ls' });
    expect(normalizeToolArgs(schema('command', 'cwd'), { workdir: '/x', command: 'ls' })).toEqual({
      command: 'ls',
      cwd: '/x',
    });
  });
});

describe('normalizeToolArgs — rule (a): exactly one declared member, or hands off', () => {
  it('leaves correctly-named args untouched (declared member already filled)', () => {
    const execArgs = { cmd: 'ls' };
    expect(normalizeToolArgs(schema('cmd', 'workdir'), execArgs)).toBe(execArgs);
    const httpArgs = { url: 'x', body: 'payload' };
    expect(normalizeToolArgs(schema('url', 'body', 'method'), httpArgs)).toBe(httpArgs);
    const memoArgs = { text: 'note', kind: 'x' };
    expect(normalizeToolArgs(schema('text', 'kind'), memoArgs)).toBe(memoArgs);
  });

  it('never touches a tool that declares TWO members of the same group', () => {
    // Hypothetical tool declaring BOTH path and file_path: genuinely distinct.
    const args = { file_path: 'x' };
    const out = normalizeToolArgs(schema('path', 'file_path'), args);
    expect(out).toBe(args);
    const both = { path: 'a' };
    expect(normalizeToolArgs(schema('path', 'file_path'), both)).toBe(both);
  });
});

describe('normalizeToolArgs — rule (e): only string values move', () => {
  it('never moves a typed value (e.g. a shell:true boolean) into a string param', () => {
    const args = { shell: true };
    expect(normalizeToolArgs(schema('command'), args)).toBe(args);
  });

  it('moves a string value under the same donor name', () => {
    expect(normalizeToolArgs(schema('command'), { shell: 'bash -lc "x"' })).toEqual({
      command: 'bash -lc "x"',
    });
  });
});

describe('normalizeToolArgs — edit / write / search families', () => {
  it('rewrites the edit_file trio old_str/new_str → old_string/new_string', () => {
    const out = normalizeToolArgs(schema('path', 'old_string', 'new_string', 'replace_all'), {
      path: 'f',
      old_str: 'a',
      new_str: 'b',
    });
    expect(out).toEqual({ path: 'f', old_string: 'a', new_string: 'b' });
  });

  it('respects rule (b) per-field on a mixed correct+alias edit call', () => {
    const out = normalizeToolArgs(schema('path', 'old_string', 'new_string'), {
      path: 'f',
      old_string: 'keep',
      new_str: 'b',
    });
    expect(out).toEqual({ path: 'f', old_string: 'keep', new_string: 'b' });
  });

  it('rewrites content aliases (text → content) when content is declared', () => {
    expect(normalizeToolArgs(schema('path', 'content'), { path: 'f', text: 'hello' })).toEqual({
      path: 'f',
      content: 'hello',
    });
  });

  it('rewrites glob → pattern for the glob tool', () => {
    expect(normalizeToolArgs(schema('pattern', 'path'), { glob: '**/*.ts' })).toEqual({
      pattern: '**/*.ts',
    });
  });
});

describe('normalizeToolArgs — identity / edge cases', () => {
  it('returns the same reference when nothing matches', () => {
    const correct = { path: 'ok' };
    expect(normalizeToolArgs(schema('path'), correct)).toBe(correct);
    const unrelated = { unrelated: 1 };
    expect(normalizeToolArgs(schema('path'), unrelated)).toBe(unrelated);
  });

  it('tolerates an undefined or empty schema', () => {
    const args = { file_path: 'a' };
    expect(normalizeToolArgs(undefined, args)).toBe(args);
    expect(normalizeToolArgs({ type: 'object', properties: {} }, args)).toBe(args);
  });

  it('skips a null/undefined alias value (rule c)', () => {
    const args = { file_path: null };
    expect(normalizeToolArgs(schema('path'), args)).toBe(args);
  });

  it('MCP tools differ only by schema shape: path-using schema is repaired', () => {
    // A `source:'mcp'` tool whose schema uses `path` benefits identically;
    // one whose schema uses `file_path` (no path) is left alone (rule a).
    expect(normalizeToolArgs(schema('path'), { file_path: 'a' })).toEqual({ path: 'a' });
    const mcpFileArgs = { file_path: 'a' };
    expect(normalizeToolArgs(schema('file_path'), mcpFileArgs)).toBe(mcpFileArgs);
  });
});

describe('aliasNormalizationEnabled — mandatory compatibility window', () => {
  it('cannot be disabled by the retired env flag', () => {
    const prev = process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
    try {
      delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      expect(aliasNormalizationEnabled()).toBe(true);
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '1';
      expect(aliasNormalizationEnabled()).toBe(true);
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '0';
      expect(aliasNormalizationEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      else process.env.CODER_TOOL_ARG_ALIASES_DISABLE = prev;
    }
  });
});

describe('table sanity', () => {
  it('groups have unique members and no member appears in two groups', () => {
    const seen = new Set<string>();
    for (const group of ALIAS_GROUPS) {
      expect(group.length).toBeGreaterThan(1);
      expect(new Set(group).size).toBe(group.length);
      for (const name of group) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });
});

describe('ToolRegistry.invoke — repairs args at the real dispatch chokepoint', () => {
  const ctx = {} as ToolContext;

  const echoPath: CoderTool = {
    name: 'read_file',
    description: '',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    source: 'native',
    handler: async (args) => ({ content: String(args.path ?? '') }),
  };

  it('lets a file_path call succeed (proves code_exec/runner/subagent paths are covered)', async () => {
    const reg = new ToolRegistry();
    reg.register(echoPath);
    const res = await reg.invoke('read_file', { file_path: 'z' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('z');
  });

  it('repairs arguments even when the retired kill switch is present', async () => {
    const prev = process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
    try {
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '1';
      const reg = new ToolRegistry();
      reg.register(echoPath);
      const res = await reg.invoke('read_file', { file_path: 'z' }, ctx);
      expect(res.content).toBe('z');
    } finally {
      if (prev === undefined) delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      else process.env.CODER_TOOL_ARG_ALIASES_DISABLE = prev;
    }
  });
});

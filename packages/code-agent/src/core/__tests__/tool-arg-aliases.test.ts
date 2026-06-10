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
  TOOL_ARG_ALIASES,
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

describe('normalizeToolArgs — rule (d): never steal a legit param', () => {
  it('leaves LSP/diagnostics tools (real file_path) untouched', () => {
    const args = { file_path: 'a.ts', line: 3, column: 1 };
    const out = normalizeToolArgs(schema('file_path', 'line', 'column'), args);
    expect(out).toBe(args);
  });

  it('leaves exec_command (real cmd) untouched but rewrites run_command (cmd → command)', () => {
    const execArgs = { cmd: 'ls' };
    expect(normalizeToolArgs(schema('cmd', 'workdir'), execArgs)).toBe(execArgs);
    expect(normalizeToolArgs(schema('command', 'cwd'), { cmd: 'ls' })).toEqual({ command: 'ls' });
  });

  it('leaves http_request (real body) and record_memo (real text) untouched', () => {
    const httpArgs = { url: 'x', body: 'payload' };
    expect(normalizeToolArgs(schema('url', 'body', 'method'), httpArgs)).toBe(httpArgs);
    const memoArgs = { text: 'note', kind: 'x' };
    expect(normalizeToolArgs(schema('text', 'kind'), memoArgs)).toBe(memoArgs);
  });

  it('does not move an alias that is itself a declared param even when canonical exists', () => {
    // Hypothetical tool declaring BOTH path and file_path: file_path is legit.
    const args = { file_path: 'x' };
    const out = normalizeToolArgs(schema('path', 'file_path'), args);
    expect(out).toBe(args);
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

describe('aliasNormalizationEnabled — kill switch (default ON)', () => {
  it('is ON by default and OFF only when the env flag is exactly "1"', () => {
    const prev = process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
    try {
      delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      expect(aliasNormalizationEnabled()).toBe(true);
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '1';
      expect(aliasNormalizationEnabled()).toBe(false);
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '0';
      expect(aliasNormalizationEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      else process.env.CODER_TOOL_ARG_ALIASES_DISABLE = prev;
    }
  });
});

describe('table sanity', () => {
  it('every alias is distinct from its own canonical and order is deterministic', () => {
    for (const [canonical, aliases] of TOOL_ARG_ALIASES) {
      expect(aliases).not.toContain(canonical);
      expect(new Set(aliases).size).toBe(aliases.length);
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

  it('honors the kill switch — disabled means the handler sees the raw (failing) args', async () => {
    const prev = process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
    try {
      process.env.CODER_TOOL_ARG_ALIASES_DISABLE = '1';
      const reg = new ToolRegistry();
      reg.register(echoPath);
      const res = await reg.invoke('read_file', { file_path: 'z' }, ctx);
      expect(res.content).toBe(''); // path never populated → handler reads empty
    } finally {
      if (prev === undefined) delete process.env.CODER_TOOL_ARG_ALIASES_DISABLE;
      else process.env.CODER_TOOL_ARG_ALIASES_DISABLE = prev;
    }
  });
});

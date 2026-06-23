import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { buildTools } from '@mcp/code-agent/core/runner/assembly/tools.js';
import { terseDescription, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';

/**
 * The runner's `buildTools` closure (runner.ts) ships an alphabetically
 * sorted tools array to the provider every turn. Server-side prompt caches
 * (Anthropic ephemeral, OpenAI/ZAI auto-cache) are byte-prefix sensitive,
 * so any reorder between turns invalidates the cache. These tests pin the
 * invariants that guarantee bit-stable prefixes.
 */

function makeTool(name: string, description = `desc for ${name}`): CoderTool {
  return {
    name,
    description,
    source: 'native',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ content: '' }),
  };
}

function buildSortedNames(reg: ToolRegistry): string[] {
  // Mirrors the sort in runner.ts buildTools().
  return reg.list().slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => t.name);
}

describe('tools array — bit-stable ordering', () => {
  it('alphabetical sort is independent of insertion order', () => {
    const r1 = new ToolRegistry();
    r1.registerAll([makeTool('zeta'), makeTool('alpha'), makeTool('mu')]);

    const r2 = new ToolRegistry();
    r2.registerAll([makeTool('mu'), makeTool('zeta'), makeTool('alpha')]);

    expect(buildSortedNames(r1)).toEqual(['alpha', 'mu', 'zeta']);
    expect(buildSortedNames(r2)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('repeated sorts yield bit-identical arrays (idempotent)', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('grep_code'), makeTool('read_file'), makeTool('edit_file'), makeTool('ask_user')]);
    const a = JSON.stringify(buildSortedNames(reg));
    const b = JSON.stringify(buildSortedNames(reg));
    expect(a).toEqual(b);
  });

  it('adding a NEW tool (mid-session tier expansion) does not reorder existing tools', () => {
    const reg = new ToolRegistry();
    reg.registerAll([makeTool('alpha'), makeTool('mu'), makeTool('zeta')]);
    const before = buildSortedNames(reg);

    // Simulate `expand_toolset` adding a new tool. New name lands in alpha
    // position, but the relative order of already-present names is preserved.
    reg.register(makeTool('beta'));
    const after = buildSortedNames(reg);

    expect(after).toEqual(['alpha', 'beta', 'mu', 'zeta']);
    // Every name from `before` keeps its relative order in `after`.
    const filtered = after.filter((n) => before.includes(n));
    expect(filtered).toEqual(before);
  });
});

describe('buildTools — create_goal stays in the surface across goal lifecycle', () => {
  // Regression: create_goal used to be removed from the tool array once a
  // goal was in_progress. Tool membership is the first segment of the
  // provider prompt-cache prefix, so that removal invalidated the whole
  // prefix on the turn after goal creation (a full re-write, every round).
  // create_goal must now stay visible regardless of goal status.
  function makeArgs(goalStatus: 'in_progress' | 'complete' | null) {
    const reg = new ToolRegistry();
    reg.registerAll([
      makeTool('create_goal'), makeTool('get_goal'), makeTool('update_goal'),
      makeTool('read_file'), makeTool('edit_file'),
    ]);
    return {
      registry: reg,
      activeTiers: null,
      toolContext: {
        cwd: tmpdir(),
        projectName: 'test',
        getGoalState: goalStatus ? () => ({ text: 'objective', status: goalStatus }) : undefined,
      } as unknown as ToolContext,
      provider: { name: 'anthropic', model: 'sonnet' } as unknown as Parameters<typeof buildTools>[0]['provider'],
    };
  }

  it('emits create_goal whether or not a goal is in_progress', () => {
    const none = buildTools(makeArgs(null)).tools.map((t) => t.name);
    const active = buildTools(makeArgs('in_progress')).tools.map((t) => t.name);
    expect(none).toContain('create_goal');
    expect(active).toContain('create_goal');
    expect(active).toEqual(none);
  });

  it('serialized tools array is byte-identical across goal status (cache prefix)', () => {
    const a = JSON.stringify(buildTools(makeArgs(null)).tools);
    const b = JSON.stringify(buildTools(makeArgs('in_progress')).tools);
    const c = JSON.stringify(buildTools(makeArgs('complete')).tools);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('terseDescription — pure transform for bootstrap profile', () => {
  it('passes through short descriptions unchanged', () => {
    const short = 'Read a file from disk.';
    expect(terseDescription(short)).toBe(short);
  });

  it('trims to the first sentence when the description is long', () => {
    const long =
      'Read a file from disk directly. ' +
      "USE: file you just created or modified that the indexer has not picked up yet, OR a config file the indexer skipped.\n" +
      "DON'T: paginate more than twice on the same file — switch tactics (skeleton, symbol, grep, force).\n" +
      "DON'T: edit without reading first.";
    expect(long.length).toBeGreaterThan(150);
    const result = terseDescription(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toBe('Read a file from disk directly.');
  });

  it('falls back to a hard cut at 150 chars when no early period is present', () => {
    const noPeriod = 'a'.repeat(300);
    const result = terseDescription(noPeriod);
    expect(result.length).toBeLessThanOrEqual(151); // 150 + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  it('is deterministic — same input always produces same output (cache safety)', () => {
    const desc =
      'Run a shell command. USE: tests, builds, lint. DONT: long-running servers.';
    expect(terseDescription(desc)).toBe(terseDescription(desc));
  });
});

describe('maybeTerse — env-gated wrapper', () => {
  it('returns desc unchanged when CODER_TERSE_TOOLS is unset', () => {
    const prev = process.env.CODER_TERSE_TOOLS;
    delete process.env.CODER_TERSE_TOOLS;
    try {
      const long = 'Read a file. ' + 'x'.repeat(300);
      expect(maybeTerse(long)).toBe(long);
    } finally {
      if (prev !== undefined) process.env.CODER_TERSE_TOOLS = prev;
    }
  });

  it('shortens when CODER_TERSE_TOOLS=1', () => {
    const prev = process.env.CODER_TERSE_TOOLS;
    process.env.CODER_TERSE_TOOLS = '1';
    try {
      const long = 'Short first. ' + 'x'.repeat(500);
      const out = maybeTerse(long);
      expect(out).toBe('Short first.');
    } finally {
      if (prev === undefined) delete process.env.CODER_TERSE_TOOLS;
      else process.env.CODER_TERSE_TOOLS = prev;
    }
  });
});

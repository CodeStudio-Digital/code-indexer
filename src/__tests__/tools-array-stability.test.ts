import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

/**
 * The catalog assembly (`buildTools`, core/runner/assembly/tools.ts) ships an alphabetically
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
  // Mirrors the sort in assembly/tools.ts buildTools().
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

    // Simulate a newly registered tool. New name lands in alpha
    // position, but the relative order of already-present names is preserved.
    reg.register(makeTool('beta'));
    const after = buildSortedNames(reg);

    expect(after).toEqual(['alpha', 'beta', 'mu', 'zeta']);
    // Every name from `before` keeps its relative order in `after`.
    const filtered = after.filter((n) => before.includes(n));
    expect(filtered).toEqual(before);
  });
});

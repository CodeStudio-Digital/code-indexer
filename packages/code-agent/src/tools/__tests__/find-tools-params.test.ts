/**
 * Integration tests for `find_tools` argument-name discovery and the two-pass
 * (strict → relaxed) output. Guards the real-world regression from 2026-07-09:
 * the query "evolution_id product evolution create" returned "No tools
 * matched" even though `evolution_id` is a top-level parameter of the App
 * Studio tools — the old scorer never looked at parameters, and its threshold
 * made description-only matches mathematically unreachable.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { buildFindToolsTool } from '../find-tools.js';

function tool(name: string, description: string, opts?: Partial<CoderTool>): CoderTool {
  return {
    name,
    description,
    source: 'native',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: '' }),
    ...opts,
  };
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool(
    'app_propose_spec_revision',
    'Create a reviewable draft spec revision for an App Studio evolution. ' +
    'The draft holds the complete refined AppSpec and waits for approval before anything is built.',
    {
      parameters: {
        type: 'object',
        properties: {
          evolution_id: {
            type: 'number',
            description: 'Evolution to attach the draft revision to. Omit to target the active evolution.',
          },
          title: { type: 'string', description: 'Short human title for the revision.' },
          change_reason: { type: 'string', description: 'Why the spec is changing.' },
          spec: {
            type: 'object',
            description: 'The complete refined AppSpec v1.',
            properties: { screens: { type: 'array' }, name: { type: 'string' } },
          },
        },
        required: ['spec'],
      },
    },
  ));
  r.register(tool(
    'app_get_spec',
    'Read the current AppSpec for this App Studio project.',
    {
      parameters: {
        type: 'object',
        properties: { evolution_id: { type: 'number' } },
      },
    },
  ));
  r.register(tool('get_task', 'Fetch a task by id from the board.', {
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }));
  r.register(tool('read_file', 'Read the full contents of a project-relative file path.'));
  r.register(tool('git_diff', 'Show staged/unstaged changes — git diff with optional path filter.'));
  return r;
}

async function findTools(query: string, runner?: unknown): Promise<string> {
  const found = buildFindToolsTool(buildRegistry());
  const result: ToolResult = await found.handler(
    { query },
    { cwd: '/tmp', projectName: 'test', runner } as never,
  );
  return typeof result.content === 'string' ? result.content : '';
}

function namesIn(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^- (\S+) \(/);
    if (m) out.push(m[1]);
  }
  return out;
}

describe('find_tools — argument-name discovery', () => {
  it('the original failing query now finds the App Studio family via evolution_id', async () => {
    const output = await findTools('evolution_id product evolution create');
    const names = namesIn(output);
    // Strong match: param anchor (evolution_id) + description word (create).
    expect(output).toMatch(/^Top /);
    expect(names[0]).toBe('app_propose_spec_revision');
    expect(names).toContain('app_get_spec');
    // The agent sees WHY it matched despite the name sharing nothing.
    expect(output).toContain('[matched arg: evolution_id]');
    // A lone ubiquitous "id" param must not drag unrelated tools in.
    expect(names).not.toContain('get_task');
  });

  it('dedups and drops stopwords end-to-end', async () => {
    const output = await findTools('the evolution for the evolution');
    expect(output).toMatch(/^Top /);
    expect(namesIn(output)).toContain('app_propose_spec_revision');
  });

  it('a fully-covered description-only query is a STRONG match (>=3 tokens)', async () => {
    const output = await findTools('reviewable draft approval');
    expect(output).toMatch(/^Top /);
    expect(namesIn(output)[0]).toBe('app_propose_spec_revision');
  });

  it('nested schema words stay invisible (no recursion into spec bodies)', async () => {
    const output = await findTools('screens');
    expect(output).toContain('No tools matched');
    expect(output).toContain('list_tools()');
  });
});

describe('find_tools — relaxed pass (closest candidates)', () => {
  it('a weak description-only hit is returned labeled, not dead-ended', async () => {
    const output = await findTools('approval');
    expect(output).toContain('No strong matches for "approval"');
    expect(output).toContain('[matched: description only]');
    expect(output).toContain('list_tools()');
    expect(namesIn(output)).toContain('app_propose_spec_revision');
  });

  it('a junk-heavy query still surfaces its one exact name hit as weak', async () => {
    const output = await findTools('diff banana pineapple kiwi');
    expect(output).toContain('No strong matches');
    expect(namesIn(output)).toEqual(['git_diff']);
    expect(output).toContain('[matched: name]');
  });

  it('weak candidates keep the hidden-tool pin affordance', async () => {
    // Empty active set: everything is hidden regardless of the real tier map.
    const output = await findTools('approval', { activeTiers: new Set<string>() });
    expect(output).toContain('No strong matches');
    expect(output).toContain('[hidden — call it directly');
    expect(output).toContain('Hint: call app_propose_spec_revision directly');
  });
});

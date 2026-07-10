/**
 * Snapshot tests for `find_tools` ranking quality.
 *
 * Guards against the two regressions reported on 2026-05-27:
 *   - `enter_worktree` ranking on "spawn_agent parallel agents" because
 *     "parallel" appears in its description.
 *   - `expand_toolset` ranking on the same query because "agents" appears
 *     in a JSON example inside its description.
 *
 * Each test builds a real `ToolRegistry`, registers a small set of native
 * tools whose descriptions are taken VERBATIM from the production tool
 * definitions, and asserts which names appear in the top-N for a given
 * query. The assertions are tight on inclusion/exclusion — they do NOT
 * snapshot the exact ordering past position 1 (which is fragile and not
 * the point of these tests).
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
  // Productlike fixture — names + descriptions match the real tool bodies.
  r.register(tool(
    'spawn_agent',
    'Spawn one or more agents to run a task in a dedicated context window. ' +
    'Pass a single-element `agents` array for sequential; multiple to run in parallel (auto, up to 8). ' +
    'Each agent returns only its final summary — intermediate tool results NEVER enter your history.',
  ));
  r.register(tool(
    'wait_agents',
    'Block until ALL specified subordinate agents reach a terminal status (completed/failed/aborted).',
  ));
  r.register(tool(
    'list_agents',
    'List every agent reachable from this runner: the caller itself plus, when in a company session, ' +
    'the master and all subordinates.',
  ));
  r.register(tool(
    'enter_worktree',
    'Create an isolated git worktree under .mcp-indexer/worktrees/<name> and switch this session into it. ' +
    'USE: parallel branches when you want to build on a feature branch without leaving main.',
  ));
  r.register(tool(
    'expand_toolset',
    'Unlock a higher tier of tools for this session. Tiers: navigate, admin. ' +
    'Example call: spawn_agent({"agents":[{"task":"..."}]}). Spawn subordinate agents (company mode).',
  ));
  r.register(tool(
    'edit_file',
    'Edit a file in place — apply a search/replace patch with full content verification.',
  ));
  r.register(tool(
    'mcp__prepare_edit',
    'Pre-flight a file edit by analysing the surrounding symbol context, dependencies, and risk.',
  ));
  r.register(tool(
    'git_diff',
    'Show staged/unstaged changes — git diff with optional path filter.',
  ));
  r.register(tool(
    'git_status',
    'Show working tree status — git status short form.',
  ));
  r.register(tool(
    'read_file',
    'Read the full contents of a project-relative file path.',
  ));
  return r;
}

async function findTools(registry: ToolRegistry, query: string, limit = 5): Promise<string> {
  const found = buildFindToolsTool(registry);
  const result: ToolResult = await found.handler({ query, limit }, { cwd: '/tmp', projectName: 'test' } as never);
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

describe('find_tools — ranking quality', () => {
  it('"spawn_agent parallel agents" puts spawn_agent on top and cuts the real noise (worktree/expand)', async () => {
    const output = await findTools(buildRegistry(), 'spawn_agent parallel agents');
    const names = namesIn(output);
    // The whole point: spawn_agent is the answer, not buried by 1-hit noise.
    expect(names[0]).toBe('spawn_agent');
    // These two are the REAL false positives — incidental description hits
    // with no semantic link to spawning agents. They MUST be cut.
    expect(names).not.toContain('enter_worktree');
    expect(names).not.toContain('expand_toolset');
    // wait_agents / list_agents are LEGITIMATELY agent tools (just other
    // verbs). We don't require them to be cut — only that spawn_agent
    // ranks higher than them. Surface their inclusion as a sanity check
    // rather than a regression.
  });

  it('"agent" (1 token) keeps the family of agent tools', async () => {
    const output = await findTools(buildRegistry(), 'agent');
    const names = namesIn(output);
    expect(names).toContain('spawn_agent');
    // wait_agents and list_agents are legitimate hits for the bare "agent"
    // query — they ARE agent tools, just different verbs.
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it('"edit" returns edit-family tools, not random matches', async () => {
    const output = await findTools(buildRegistry(), 'edit');
    const names = namesIn(output);
    expect(names).toContain('edit_file');
    expect(names).toContain('mcp__prepare_edit');
    expect(names).not.toContain('enter_worktree');
    expect(names).not.toContain('spawn_agent');
  });

  it('"git diff" prioritises git_diff', async () => {
    const output = await findTools(buildRegistry(), 'git diff');
    const names = namesIn(output);
    expect(names[0]).toBe('git_diff');
  });

  it('"parallel" alone returns only WEAK candidates, clearly labeled', async () => {
    const output = await findTools(buildRegistry(), 'parallel');
    // Description-only hits never present as a strong match ("Top N…") — the
    // relaxed pass surfaces them as labeled closest-candidates instead of the
    // old dead end, so the agent learns the landscape without being misled.
    expect(output).toContain('No strong matches');
    expect(output).not.toMatch(/^Top /);
    expect(namesIn(output)).toContain('spawn_agent');
    expect(output).toContain('[matched: description only]');
  });
});

describe('find_tools — discovery affordances (param summary + pin awareness)', () => {
  function schemaRegistry(): ToolRegistry {
    const r = new ToolRegistry();
    r.register(tool('edit_file', 'Edit a file in place — apply a search/replace patch.', {
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          dry_run: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    }));
    return r;
  }

  async function findWithRunner(
    registry: ToolRegistry,
    query: string,
    runner?: unknown,
  ): Promise<string> {
    const found = buildFindToolsTool(registry);
    const result: ToolResult = await found.handler(
      { query },
      { cwd: '/tmp', projectName: 'test', runner } as never,
    );
    return typeof result.content === 'string' ? result.content : '';
  }

  it('candidates carry a compact arg summary (required first, optional with ?)', async () => {
    const output = await findWithRunner(schemaRegistry(), 'edit file');
    expect(output).toContain('args: ');
    expect(output).toContain('path:string');
    expect(output).toContain('dry_run?:boolean');
    // Required params render before optional ones.
    expect(output.indexOf('old_string:string')).toBeLessThan(output.indexOf('dry_run?:boolean'));
  });

  it('tier-hidden tools advertise the direct-call-pins path', async () => {
    // edit_file is navigate-tier in the real tier map; runner only has bootstrap.
    const output = await findWithRunner(schemaRegistry(), 'edit file', {
      activeTiers: new Set(['bootstrap']),
    });
    expect(output).toContain('[hidden — call it directly (it will be pinned into your toolset)');
    expect(output).toContain("expand_toolset('navigate')");
  });

  it('a pinned tool is reported visible even when its tier is inactive', async () => {
    const output = await findWithRunner(schemaRegistry(), 'edit file', {
      activeTiers: new Set(['bootstrap']),
      pinnedTools: new Set(['edit_file']),
    });
    expect(output).not.toContain('[hidden');
  });

  it('empty query errors out cleanly', async () => {
    const found = buildFindToolsTool(buildRegistry());
    const result = await found.handler({ query: '' }, { cwd: '/tmp', projectName: 'test' } as never);
    expect(result.isError).toBe(true);
  });

  it('returns helpful "no match" message when nothing scores high enough', async () => {
    const output = await findTools(buildRegistry(), 'kubernetes deployment yaml');
    // Either no matches at all, or the "No tools matched" sentinel.
    expect(output).toMatch(/No tools matched|^Top 0/);
  });
});

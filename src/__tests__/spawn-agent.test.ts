import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return {
    ...actual,
    runSubagent: vi.fn(),
    runParallelAgents: vi.fn(),
  };
});

const { buildSpawnAgentTool, buildSubagentWorkspaceBriefing } = await import('@mcp/code-agent/tools/spawn-agent.js');
const { runSubagent, runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');

const ctx: ToolContext = {
  cwd: '/tmp',
  projectName: 'test',
  runner: {
    sessionId: 42,
    agentLoopV2: false,
    emit: vi.fn(),
  },
} as unknown as ToolContext;

const globalCtx: ToolContext = {
  ...ctx,
  cwd: 'C:/data/global-workspaces/ws-1',
  projectName: '__global_ws_1',
  globalWorkspace: {
    syntheticProjectName: '__global_ws_1',
    rootPath: 'C:/data/global-workspaces/ws-1',
    projects: [
      {
        projectId: 1,
        name: 'Backend Loyalty',
        slug: 'backend_loyalty',
        rootPath: 'D:/repos/backend',
        isPrimary: true,
      },
      {
        projectId: 2,
        name: 'Intranet Loyalty',
        slug: 'intranet_loyalty',
        rootPath: 'D:/repos/intranet',
        isPrimary: false,
      },
    ],
  },
} as unknown as ToolContext;

const provider = { name: 'stub', model: 'subagent-test' } as never;

function fakeTool(name: string, handler: CoderTool['handler']): CoderTool {
  return {
    name,
    description: `${name} fake`,
    source: 'native',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    handler,
  };
}

const tool = (
  name: string,
  source: CoderTool['source'] = 'native',
  mutates?: boolean,
) => ({ name, source, mutates }) as CoderTool;

function allowed(allowlist: Parameters<typeof runSubagent>[1]['allowlist'], coderTool: CoderTool): boolean {
  if (allowlist === null) return true;
  if (typeof allowlist === 'function') return allowlist(coderTool);
  return allowlist.has(coderTool.name);
}

function buildTool(registry = new ToolRegistry()) {
  return buildSpawnAgentTool({
    provider,
    parentTools: [],
    sessionStore: undefined,
  }, registry);
}

beforeEach(() => {
  vi.mocked(runSubagent).mockReset();
  vi.mocked(runParallelAgents).mockReset();
  vi.mocked(runSubagent).mockResolvedValue({
    reason: 'completed',
    finalText: 'single summary',
    usage: { input_tokens: 10, output_tokens: 3 },
    sandboxViolations: [],
  });
  vi.mocked(runParallelAgents).mockResolvedValue({
    results: [],
    totalUsage: { input_tokens: 0, output_tokens: 0 },
  });
  vi.mocked(ctx.runner!.emit).mockClear();
});

describe('spawn_agent profiles', () => {
  it('runs a default single ephemeral agent with the explore profile', async () => {
    const wrapper = buildTool();
    const result = await wrapper.handler({ kind: 'ephemeral', task: 'find foo' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('type=explore');
    expect(result.content).toContain('single summary');
    expect(runSubagent).toHaveBeenCalledTimes(1);

    const spec = vi.mocked(runSubagent).mock.calls[0][1];
    expect(spec.label).toBe('investigate-1');
    expect(spec.systemPrompt).toContain('EXPLORE subagent');
    expect(allowed(spec.allowlist, tool('read_file'))).toBe(true);
    expect(allowed(spec.allowlist, tool('write_file'))).toBe(false);
  });

  it('adds global workspace context to single subagent tasks', async () => {
    const wrapper = buildTool();
    await wrapper.handler({ kind: 'ephemeral', task: 'find recurring charge flow' }, globalCtx);

    const spec = vi.mocked(runSubagent).mock.calls[0][1];
    const text = (spec.initialMessages[0].content[0] as { text: string }).text;

    expect(text).toContain('<workspace-context>');
    expect(text).toContain('GLOBAL session over a virtual union workspace');
    expect(text).toContain('backend_loyalty/ -> Backend Loyalty (primary)');
    expect(text).toContain('intranet_loyalty/ -> Intranet Loyalty');
    expect(text).toContain('Do not pass or invent project_name');
    expect(text).toContain('# Delegated task\nfind recurring charge flow');
  });

  it('accepts verifier aliases and uses the verify toolset', async () => {
    const wrapper = buildTool();
    const result = await wrapper.handler({
      agents: [{ task: 'run the relevant checks', profile: 'verifier' }],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('type=verify');

    const spec = vi.mocked(runSubagent).mock.calls[0][1];
    expect(spec.label).toBe('verify-1');
    expect(spec.systemPrompt).toContain('VERIFY subagent');
    expect(allowed(spec.allowlist, tool('run_command'))).toBe(true);
    expect(allowed(spec.allowlist, tool('get_diagnostics'))).toBe(true);
    expect(allowed(spec.allowlist, tool('write_file'))).toBe(false);
    expect(spec.pathScope).toBeUndefined();
  });

  it('runs a single reviewer profile with a read-only toolset', async () => {
    const wrapper = buildTool();
    const result = await wrapper.handler({
      agents: [{ task: 'review the recent diff', profile: 'reviewer' }],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('type=review');

    const spec = vi.mocked(runSubagent).mock.calls[0][1];
    expect(spec.label).toBe('review-1');
    expect(spec.systemPrompt).toContain('REVIEW subagent');
    expect(allowed(spec.allowlist, tool('git_diff'))).toBe(true);
    expect(allowed(spec.allowlist, tool('read_file'))).toBe(true);
    expect(allowed(spec.allowlist, tool('run_command'))).toBe(false);
    expect(allowed(spec.allowlist, tool('write_file'))).toBe(false);
    expect(spec.pathScope).toBeUndefined();
  });

  it('resolves the legacy `type` field to verify and review profiles', async () => {
    const wrapper = buildTool();

    await wrapper.handler({ agents: [{ task: 'run the checks', type: 'verify' }] }, ctx);
    await wrapper.handler({ agents: [{ task: 'review the diff', type: 'review' }] }, ctx);

    const verifySpec = vi.mocked(runSubagent).mock.calls[0][1];
    expect(verifySpec.systemPrompt).toContain('VERIFY subagent');
    expect(allowed(verifySpec.allowlist, tool('run_command'))).toBe(true);
    expect(allowed(verifySpec.allowlist, tool('write_file'))).toBe(false);

    const reviewSpec = vi.mocked(runSubagent).mock.calls[1][1];
    expect(reviewSpec.systemPrompt).toContain('REVIEW subagent');
    expect(allowed(reviewSpec.allowlist, tool('run_command'))).toBe(false);
    expect(allowed(reviewSpec.allowlist, tool('write_file'))).toBe(false);
  });

  it('uses enforce-writes path scope for implement profiles', async () => {
    const wrapper = buildTool();
    await wrapper.handler({
      agents: [{
        task: 'change the parser',
        tool_profile: 'implementer',
        files: ['src/parser.ts'],
      }],
    }, ctx);

    const spec = vi.mocked(runSubagent).mock.calls[0][1];
    expect(spec.systemPrompt).toContain('IMPLEMENTATION subagent');
    expect(spec.pathScope).toEqual(['src/parser.ts']);
    expect(spec.pathScopeMode).toBe('enforce-writes');
  });

  it('rejects unknown profile names with the valid profile list', async () => {
    const wrapper = buildTool();
    const result = await wrapper.handler({
      agents: [{ task: 'look around', profile: 'mystery-agent' }],
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("profile='mystery-agent' invalid");
    expect(result.content).toContain('investigator');
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('passes mixed profiles to parallel agents without flattening toolsets', async () => {
    vi.mocked(runParallelAgents).mockImplementation(async (_parent, agents) => ({
      results: agents.map((agent) => ({
        label: agent.label,
        reason: 'completed',
        finalText: `${agent.label} done`,
        usage: { input_tokens: 1, output_tokens: 1 },
        sandboxViolations: [],
        toolCallCount: 0,
      })),
      totalUsage: { input_tokens: agents.length, output_tokens: agents.length },
    }));

    const wrapper = buildTool();
    const result = await wrapper.handler({
      agents: [
        { task: 'find references', profile: 'investigator' },
        { task: 'review the diff', profile: 'reviewer' },
        { task: 'run tests', profile: 'verifier' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(runParallelAgents).toHaveBeenCalledTimes(1);

    const specs = vi.mocked(runParallelAgents).mock.calls[0][1];
    expect(specs.map((s) => s.label)).toEqual(['investigate-1', 'review-2', 'verify-3']);
    expect(specs[0].systemPrompt).toContain('EXPLORE subagent');
    expect(specs[1].systemPrompt).toContain('REVIEW subagent');
    expect(specs[2].systemPrompt).toContain('VERIFY subagent');
    expect(allowed(specs[0].allowlist!, tool('run_command'))).toBe(false);
    expect(allowed(specs[2].allowlist!, tool('run_command'))).toBe(true);
    expect(result.content).toContain(
      '[type=review reason=completed tools=0 input=1 output=1 max_tools=80]',
    );
    expect(result.content).toContain(
      '[type=verify reason=completed tools=0 input=1 output=1 max_tools=80]',
    );
  });

  it('adds global workspace context to parallel subagent tasks', async () => {
    vi.mocked(runParallelAgents).mockResolvedValueOnce({
      results: [],
      totalUsage: { input_tokens: 0, output_tokens: 0 },
    });

    const wrapper = buildTool();
    await wrapper.handler({
      agents: [
        { task: 'map backend flow', profile: 'investigator' },
        { task: 'map intranet flow', profile: 'investigator' },
      ],
    }, globalCtx);

    const specs = vi.mocked(runParallelAgents).mock.calls[0][1];
    expect(specs[0].task).toContain('backend_loyalty/ -> Backend Loyalty (primary)');
    expect(specs[0].task).toContain('# Delegated task\nmap backend flow');
    expect(specs[1].task).toContain('intranet_loyalty/ -> Intranet Loyalty');
    expect(specs[1].task).toContain('# Delegated task\nmap intranet flow');
  });

  it('does not add workspace briefing outside global sessions', () => {
    expect(buildSubagentWorkspaceBriefing(ctx)).toBe('');
  });
});

describe('spawn_agent persistent delegation', () => {
  it('delegates persistent Company agents to spawn_subordinate_agent', async () => {
    const subHandler = vi.fn(async (args: Record<string, unknown>) => ({
      content: `spawned role=${args.role} project=${args.project_id} wait=${args.wait}`,
    }));
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subordinate_agent', subHandler));
    const wrapper = buildTool(registry);

    const result = await wrapper.handler({
      kind: 'persistent',
      role: 'frontend',
      task: 'add a button',
      project_id: 3,
      tier: 'navigate',
      wait: true,
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('role=frontend');
    expect(subHandler).toHaveBeenCalledTimes(1);
    expect(subHandler.mock.calls[0][0]).toMatchObject({
      role: 'frontend',
      task: 'add a button',
      project_id: 3,
      tier: 'navigate',
      wait: true,
    });
    expect(runSubagent).not.toHaveBeenCalled();
  });
});

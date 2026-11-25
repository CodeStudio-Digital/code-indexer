import { describe, expect, it, vi } from 'vitest';
import { AGENTS, type AgentDefinition } from '@mcp/code-agent/agents/index.js';
import { buildSystemPrompt } from '@mcp/code-agent/core/system-prompt.js';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type {
  ChatProvider,
  ChatRequest,
} from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';

class NoopProvider implements ChatProvider {
  readonly name = 'live-settings-test';
  model = 'live-settings-test-1';

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(_request: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'The cache keeps recent results.' };
    yield { type: 'done' };
  }
}

describe('CoderRunner live settings', () => {
  it('sends the current scope to the provider when the permission mode changes', async () => {
    const provider = new NoopProvider();
    const chat = vi.spyOn(provider, 'chat');
    const runner = new CoderRunner({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'auto scope',
      systemPromptForPermissionMode: (mode) => `${mode} scope`,
      toolContext: { cwd: process.cwd(), projectName: 'live-settings-test' },
    });
    runner.setToolPermissionMode('unrestricted');
    await runner.run();
    expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ system: expect.stringContaining('unrestricted scope') }));
    runner.setToolPermissionMode('auto');
    await runner.run();
    expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ system: expect.stringContaining('auto scope') }));
  });

  it('applies permission and output-cap changes without rebuilding the runner', () => {
    const toolContext: ToolContext = {
      cwd: process.cwd(),
      projectName: 'live-settings-test',
    };
    const runner = new CoderRunner({
      provider: new NoopProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext,
      toolOutputCapLevel: 'economic',
    });
    const economicCap = runner.effectivePushTimeCap;
    const economicInlineCap = toolContext.toolOutputInlineCap;

    expect(runner.getToolPermissionMode()).toBe('auto');
    runner.setToolPermissionMode('unrestricted');
    expect(runner.getToolPermissionMode()).toBe('unrestricted');

    runner.setToolOutputCapLevel('ultra');
    expect(runner.effectivePushTimeCap).toBeGreaterThan(economicCap);
    expect(toolContext.toolOutputInlineCap).toBeGreaterThan(
      economicInlineCap ?? 0,
    );

    runner.setToolOutputCapLevel('economic');
    expect(runner.effectivePushTimeCap).toBe(economicCap);
    expect(toolContext.toolOutputInlineCap).toBe(economicInlineCap);
  });

  it('reports unlimited by default and accepts session limits before a run', async () => {
    const runner = new CoderRunner({
      provider: new NoopProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'test',
      toolContext: {
        cwd: process.cwd(),
        projectName: 'live-run-limits-test',
      },
    });
    const starts: Array<{ maxTurns: number | null }> = [];
    runner.on('run_started', (payload) => starts.push(payload));

    runner.setRunLimits(null, 15);
    await runner.run();

    expect(starts).toEqual([
      expect.objectContaining({ maxTurns: null }),
    ]);
  });

  it.each([
    ['Como funciona o cache?', true, 1],
    ['Como funciona o cache? Preciso de um plano de migração.', true, 2],
    ['Prepare a migration plan.', false, 1],
  ] as const)('uses a Plan reminder only for a deliverable with an available review route (%s)', async (message, hasReview, expectedCalls) => {
    const provider = new NoopProvider();
    const chat = vi.spyOn(provider, 'chat');
    const registry = new ToolRegistry();
    if (hasReview) registry.registerAll([submitPlan]);
    const runner = new CoderRunner({
      provider, registry, systemPrompt: 'Plan', agentId: 'plan', planMode: true, maxTurns: 3,
      toolContext: { cwd: process.cwd(), projectName: 'plan-reminder-test' },
    });
    runner.pushUserMessage(message);
    await runner.run();
    expect(chat).toHaveBeenCalledTimes(expectedCalls);
  });

  it('reopens an approved plan inline and keeps writes gated until the revision is approved', async () => {
    let activePlan = { text: 'Keep the original cache.', status: 'approved' };
    const changes: string[] = [];
    const registry = new ToolRegistry();
    const edit = vi.fn(async () => ({ content: 'Changed the cache.' }));
    registry.registerAll([submitPlan, {
      name: 'edit_file', source: 'native', description: 'Edit a file.',
      parameters: { type: 'object', properties: {} }, handler: edit,
    }]);
    const promptForAgent = (agent: AgentDefinition) => buildSystemPrompt({
      projectName: 'plan-revision-test', projectRoot: process.cwd(), os: 'win32',
      agentId: agent.id, planMode: agent.planMode, specMode: !!agent.specMode,
      availableTools: new Set(registry.list().map(tool => tool.name)),
      canRevisePlan: activePlan.status === 'approved',
    });
    const prompts: string[] = [];
    const script = [
      { name: 'submit_plan', input: { plan: 'Replace the cache.', revision: true } },
      { name: 'edit_file', input: {} },
      { name: 'submit_plan', input: { plan: 'Replace the cache and preserve its keys.' } },
      { name: 'edit_file', input: {} },
    ];
    let turns = 0;
    const provider: ChatProvider = {
      name: 'plan-revision-test', model: 'fixture', setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        prompts.push(request.system);
        const call = script[turns++];
        if (call) {
          const { name, input } = call;
          expect(request.tools?.some(tool => tool.name === name)).toBe(true);
          const id = `revision-${turns}`;
          yield { type: 'tool_call_start', id, name };
          yield { type: 'tool_call_end', id, name, input };
        } else {
          yield { type: 'text_delta', text: 'The approved revision was implemented.' };
        }
        yield { type: 'done' };
      },
    };
    const toolContext: ToolContext = {
      cwd: process.cwd(), projectName: 'plan-revision-test',
      getActivePlan: () => activePlan,
      recordPlan: (_id, text) => { activePlan = { text, status: 'pending' }; },
      resolvePlan: (_id, status) => { activePlan = { ...activePlan, status }; },
      setSessionAgent: (agent) => {
        changes.push(agent);
        runner.applyLiveAgent(AGENTS[agent], agent);
      },
    };
    const runner = new CoderRunner({
      provider, registry, toolContext, systemPrompt: promptForAgent(AGENTS.build), systemPromptForAgent: promptForAgent,
      agentId: 'build', planMode: false, maxTurns: 8,
    });
    const reviews: Array<{ plan: string; mode: boolean; approved: boolean }> = [];
    const blocked: string[] = [];
    runner.on('blocked', event => blocked.push(event.reason));
    runner.on('plan_posted', ({ plan }) => {
      reviews.push({ plan, mode: runner.planMode, approved: runner.isPlanApproved() });
      runner.provideUserInput(reviews.length === 1
        ? JSON.stringify({ approved: false, feedback: 'Preserve the keys.' })
        : JSON.stringify({ approved: true }));
    });

    runner.pushUserMessage('Revise o plano aprovado para trocar o cache antes de implementar.');
    await runner.run();

    expect(turns).toBe(5);
    expect(prompts.map(prompt => [...prompt.matchAll(/^# (Build|Plan) mode is ACTIVE$/gm)].map(match => match[1])))
      .toEqual([['Build'], ['Plan'], ['Plan'], ['Build'], ['Build']]);
    expect(prompts[0]).toContain('revision: true');
    expect(prompts[1]).not.toContain('revision: true');
    expect(reviews).toEqual([
      { plan: 'Replace the cache.', mode: true, approved: false },
      { plan: 'Replace the cache and preserve its keys.', mode: true, approved: false },
    ]);
    expect(blocked).toContain('plan_mode');
    expect(edit).toHaveBeenCalledOnce();
    expect(changes).toEqual(['plan', 'build']);
    expect(activePlan.status).toBe('approved');
  });
});

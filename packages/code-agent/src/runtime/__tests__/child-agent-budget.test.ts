/**
 * The budget of a child-agent session run, on a real runner with a scripted
 * provider: the profile caps and prompt, the one-shot warning at 80%, the
 * hard cutoff and its salvage summary.
 */
import { describe, expect, it } from 'vitest';
import { CoderRunner } from '../../core/runner.js';
import { ToolRegistry } from '../../core/registry.js';
import type { ChatDelta } from '../../core/messages.js';
import type { ToolContext } from '../../core/tool.js';
import type { ChatProvider } from '../../providers/adapter.js';
import { MICRO_AGENT_PROFILES } from '../../tools/micro-agent-profiles.js';
import { loadChildAgentRun, type ChildAgentRun } from '../child-agent-run.js';
import { attachChildAgentBudget } from '../child-agent-budget.js';

const childView = (profile: string, readOnly = false) => ({ getChildAgentSession: async () => ({
  id: 'c' as never, parent_session_id: 'p' as never, depth: 2, status: 'idle' as const, is_archived: false,
  updated_at: '', profile, read_only: readOnly, creation_fingerprint: 'f', created_at: '', conclusion: null }) });

/** Calls `probe` on every turn until told otherwise; the salvage call answers in text. */
function loopingProvider(): ChatProvider {
  let call = 0;
  return { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request): AsyncIterable<ChatDelta> {
    if (request.system?.includes('forcibly stopped')) {
      yield { type: 'text_delta', text: 'Salvaged: probed three times.' };
      yield { type: 'done', stop_reason: 'end_turn' };
      return;
    }
    call++;
    yield { type: 'tool_call_start', id: `t${call}`, name: 'probe' };
    yield { type: 'tool_call_end', id: `t${call}`, name: 'probe', input: { n: call } };
    yield { type: 'done', stop_reason: 'tool_use' };
  } };
}

describe('child-agent run configuration', () => {
  it.each([
    ['explore', 80, 840_000], ['implement', 150, 1_800_000], ['verify', 80, 900_000], ['review', 80, 840_000], ['full', 150, 1_800_000],
  ] as const)('%s keeps the in-process caps and prompt', async (profile, maxToolCalls, timeoutMs) => {
    const run = (await loadChildAgentRun(childView(profile), 'c'))!;
    expect(run.limits).toMatchObject({ maxToolCalls, timeoutMs });
    expect(run.promptSection).toContain(`# Child agent (${profile}, depth 2)`);
    expect(run.promptSection).toContain(MICRO_AGENT_PROFILES[profile].systemPrompt.trim());
  });

  it('applies an admin per-profile override and states a read-only posture', async () => {
    const asked: string[][] = [];
    const run = (await loadChildAgentRun(childView('verify', true), 'c', (profile, creator) => {
      asked.push([profile, creator]);
      return { maxToolCalls: 5, timeoutMs: 0 };
    }))!;
    // Keyed by the creator session, whose provider config holds the override.
    expect(asked).toEqual([['verify', 'p']]);
    expect(run.limits).toMatchObject({ maxToolCalls: 5, timeoutMs: 0 });
    expect(run.promptSection).toContain('read-only');
  });
});

describe('child-agent run budget', () => {
  it('warns once at 80%, cuts the run at the cap and salvages a summary', async () => {
    const run: ChildAgentRun = { ...(await loadChildAgentRun(childView('explore'), 'c'))!, limits: { maxToolCalls: 5, timeoutMs: 0, stallMs: 60_000 } };
    const registry = new ToolRegistry();
    registry.register({ name: 'probe', source: 'native', description: 'probe', parameters: { type: 'object', properties: {} },
      mutates: false, riskLevel: 'read', handler: async () => ({ content: 'ok' }) });
    const provider = loopingProvider();
    const runner = new CoderRunner({ provider, registry, systemPrompt: 'system',
      toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'probe until done' }] }] });
    const prompts: string[] = [];
    const original = runner.setSystemPromptForNextTurn.bind(runner);
    runner.setSystemPromptForNextTurn = (prompt) => { prompts.push(prompt); original(prompt); };
    const budget = attachChildAgentBudget(runner, run, () => 'system');

    const result = await runner.run();
    const salvage = await budget.salvage(provider, runner.messages);
    budget.cleanup();

    expect(result.reason).toBe('aborted');
    expect(budget.cutoff()).toBe('task tool limit reached (5/5)');
    expect(budget.toolCalls()).toBe(5);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('HARD BUDGET WARNING');
    expect(salvage.text).toContain('Salvaged');
  });

  it('cuts a run that outlives its wall-clock limit', async () => {
    const run: ChildAgentRun = { ...(await loadChildAgentRun(childView('verify'), 'c'))!, limits: { maxToolCalls: 0, timeoutMs: 300, stallMs: 60_000 } };
    // A provider that never answers until the run is aborted.
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      while (!request.signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    const cutoff = new AbortController();
    const runner = new CoderRunner({ provider, registry: new ToolRegistry(), systemPrompt: 'system',
      toolContext: { cwd: process.cwd(), projectName: 'test', signal: cutoff.signal } as ToolContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'wait' }] }] });
    const budget = attachChildAgentBudget(runner, run, () => 'system', { onCutoff: (message) => cutoff.abort(new Error(message)) });
    expect((await runner.run()).reason).toBe('aborted');
    expect(budget.cutoff()).toMatch(/hard timeout/);
    budget.cleanup();
  }, 15_000);

  it('leaves a run that ends on its own without a cutoff', async () => {
    const run = (await loadChildAgentRun(childView('review'), 'c'))!;
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat() {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    const runner = new CoderRunner({ provider, registry: new ToolRegistry(), systemPrompt: 'system',
      toolContext: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'answer' }] }] });
    const budget = attachChildAgentBudget(runner, run, () => 'system');
    expect((await runner.run()).reason).toBe('completed');
    expect(budget.cutoff()).toBeNull();
    budget.cleanup();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";
import type { AgentId } from '@mcp/code-agent/agents/index.js';

/**
 * Provider that emits a single `submit_plan` tool_use on its first turn, then
 * finishes with plain text on subsequent turns once the tool result is in.
 */
class PlanSubmittingProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  private call = 0;
  setModel(m: string) {
    this.model = m;
  }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.call++;
    if (this.call === 1) {
      yield {
        type: 'tool_call_end',
        id: 'call-1',
        name: 'submit_plan',
        input: { plan: '1. Edit src/foo.ts\n2. Run tests' },
      };
    } else {
      yield { type: 'text_delta', text: 'plan approved, executing next' };
    }
    yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

function makeRunner(opts: { agentId: AgentId | null; setSessionAgent?: (a: AgentId) => void }) {
  const registry = new ToolRegistry();
  registry.register(submitPlan);
  return new CoderRunner({
    provider: new PlanSubmittingProvider(),
    registry,
    systemPrompt: 'sys',
    toolContext: {
      cwd: '/tmp',
      projectName: 'test',
      // Wire the spy so the test can observe transitions.
      setSessionAgent: opts.setSessionAgent,
    },
    agentId: opts.agentId,
    // Submit-plan handler requires plan mode logically; the runner doesn't
    // enforce it on the tool side, but we set it for parity with the real
    // session shape (plan agent ⇒ planMode=true).
    planMode: true,
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'plan something' }] }],
  });
}

describe('runner mode transition — auto plan → build after approval', () => {
  it('persists agent="build" and injects a system reminder when the active agent was "plan"', async () => {
    const setSessionAgent = vi.fn();
    const runner = makeRunner({ agentId: 'plan', setSessionAgent });

    // Approve the plan as soon as the runner blocks on user input.
    const tick = setInterval(() => {
      if (runner.isWaitingForInput()) {
        clearInterval(tick);
        runner.provideUserInput(JSON.stringify({ approved: true }));
      }
    }, 5);

    await runner.run();
    clearInterval(tick);

    expect(setSessionAgent).toHaveBeenCalledTimes(1);
    expect(setSessionAgent).toHaveBeenCalledWith('build');

    // Last user message should be the injected system-reminder.
    const lastUserMsg = [...runner.messages].reverse().find((m) => m.role === 'user');
    expect(lastUserMsg).toBeTruthy();
    const text = lastUserMsg!.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toMatch(/<system-reminder>/);
    expect(text).toMatch(/Mode transition: Plan → Build/);
    expect(text).toMatch(/plan was approved/);
  });

  it('does NOT transition when the active agent is "build" (approving a stray plan)', async () => {
    const setSessionAgent = vi.fn();
    const runner = makeRunner({ agentId: 'build', setSessionAgent });

    const tick = setInterval(() => {
      if (runner.isWaitingForInput()) {
        clearInterval(tick);
        runner.provideUserInput(JSON.stringify({ approved: true }));
      }
    }, 5);

    await runner.run();
    clearInterval(tick);

    expect(setSessionAgent).not.toHaveBeenCalled();
    const reminder = runner.messages.some((m) =>
      m.content.some((c) => c.type === 'text' && /Mode transition/.test(c.text)),
    );
    expect(reminder).toBe(false);
  });

  it('does NOT transition when the plan was rejected', async () => {
    const setSessionAgent = vi.fn();
    const runner = makeRunner({ agentId: 'plan', setSessionAgent });

    const tick = setInterval(() => {
      if (runner.isWaitingForInput()) {
        clearInterval(tick);
        runner.provideUserInput(JSON.stringify({ approved: false, feedback: 'no' }));
      }
    }, 5);

    await runner.run();
    clearInterval(tick);

    expect(setSessionAgent).not.toHaveBeenCalled();
  });
});

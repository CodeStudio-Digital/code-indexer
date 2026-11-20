import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { submitPlan } from '@mcp/code-agent/tools/plan.js';
import { submitTasks } from '@mcp/code-agent/tools/tasks.js';
import { askUser, formatInterruptedResult } from '@mcp/code-agent/tools/interaction.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000007';
const OTHER_AGENT_RUN_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Minimal fake runner that satisfies the bits the interactive tools touch:
 *  - waitForUserInput() resolves to the next queued response
 *  - emit() is a no-op aside from event-emitter wiring (tests inspect via spy)
 *  - approvePlan() flips a flag we expose for assertions
 */
class FakeRunner extends EventEmitter {
  private queue: string[] = [];
  approved = false;
  enqueue(response: string) {
    this.queue.push(response);
  }
  waitForUserInput(): Promise<string> {
    const next = this.queue.shift();
    if (next === undefined) return Promise.reject(new Error('no input queued'));
    return Promise.resolve(next);
  }
  approvePlan() { this.approved = true; }
  // Surface the plan-mode API the interactive tools touch.
  isPlanMode(): boolean { return false; }
}

function ctx(runner: FakeRunner): ToolContext {
  return {
    cwd: '/tmp',
    projectName: 'test',
    runner: runner as unknown as ToolContext['runner'],
  };
}

describe('submit_plan idempotency', () => {
  it('rejects re-submission of the same plan after the user requested revisions', async () => {
    const runner = new FakeRunner();

    runner.enqueue(JSON.stringify({ approved: false, feedback: 'no' }));
    const r1 = await submitPlan.handler({ plan: '1. Touch foo.ts\n2. Run tests' }, ctx(runner));
    expect(r1.isError).toBeFalsy();
    expect(r1.content).toContain('Plan revision requested');

    // No new input queued: re-submission should short-circuit before pausing
    const r2 = await submitPlan.handler({ plan: '1. Touch foo.ts\n2. Run tests' }, ctx(runner));
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain('already requested revisions');
  });

  it('clears the revision-request ledger after a plan is approved', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ approved: false }));
    runner.enqueue(JSON.stringify({ approved: true }));
    runner.enqueue(JSON.stringify({ approved: true }));

    await submitPlan.handler({ plan: 'A' }, ctx(runner));    // revision requested
    await submitPlan.handler({ plan: 'B' }, ctx(runner));    // approved → clears ledger
    const r = await submitPlan.handler({ plan: 'A' }, ctx(runner)); // accepts again
    expect(r.isError).toBeFalsy();
    expect(runner.approved).toBe(true);
  });

  it('whitespace-normalises the hash so trivial reformat reuses the revision request', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ approved: false }));
    await submitPlan.handler({ plan: '1. Step\n2. Step' }, ctx(runner));
    const r = await submitPlan.handler({ plan: '1.  Step\n  2. Step' }, ctx(runner));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('already requested revisions');
  });

  it('labels an explicit abort as a user rejection, not a validation failure', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({ approved: false, aborted: true, feedback: 'stop here' }));

    const result = await submitPlan.handler({ plan: 'Do not execute this plan' }, ctx(runner));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Plan rejected by user.');
    expect(result.content).toContain('stop here');
  });

  it('returns interrupted envelope when waitForUserInput resolves with interrupted', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({
      interrupted: true,
      kind: 'question',
      agentRunId: AGENT_RUN_ID,
      role: 'qa',
    }));
    const r = await submitPlan.handler({ plan: 'X' }, ctx(runner));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('answer_subordinate_question');
    expect(r.content).toContain('agent_run_id');
  });
});

describe('submit_tasks validation', () => {
  it('rejects a single-task list and points to submit_plan', async () => {
    const runner = new FakeRunner();
    const r = await submitTasks.handler(
      {
        summary: 'one thing',
        tasks: [
          { id: 't1', title: 'a', description: 'b', files: [], references: [] },
        ],
      },
      ctx(runner),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('2+ independent tasks');
    expect(r.content).toContain('submit_plan');
  });
});

describe('formatInterruptedResult', () => {
  it('produces a JSON envelope with next_action and a human-readable hint', () => {
    const out = formatInterruptedResult('ask_user', {
      kind: 'plan',
      agentRunId: AGENT_RUN_ID,
      role: 'frontend',
    });
    const [envelope, hint] = out.split('\n');
    const parsed = JSON.parse(envelope);
    expect(parsed.interrupted).toBe(true);
    expect(parsed.interrupted_tool).toBe('ask_user');
    expect(parsed.next_action).toBe('approve_subordinate_plan');
    expect(parsed.agent_run_id).toBe(AGENT_RUN_ID);
    expect(parsed.role).toBe('frontend');
    expect(hint).toContain('approve_subordinate_plan');
    expect(hint).toContain('frontend');
  });

  it('routes question kind to answer_subordinate_question', () => {
    const out = formatInterruptedResult('submit_plan', {
      kind: 'question',
      agentRunId: OTHER_AGENT_RUN_ID,
      role: 'r',
    });
    const parsed = JSON.parse(out.split('\n')[0]);
    expect(parsed.next_action).toBe('answer_subordinate_question');
  });

  it('routes tasks kind to approve_subordinate_tasks', () => {
    const out = formatInterruptedResult('submit_plan', {
      kind: 'tasks',
      agentRunId: OTHER_AGENT_RUN_ID,
      role: 'r',
    });
    const parsed = JSON.parse(out.split('\n')[0]);
    expect(parsed.next_action).toBe('approve_subordinate_tasks');
  });

  it('passes through with null next_action when kind is missing', () => {
    const out = formatInterruptedResult('ask_user', {});
    const parsed = JSON.parse(out.split('\n')[0]);
    expect(parsed.next_action).toBeNull();
  });
});

describe('ask_user — interrupted path', () => {
  it('returns structured envelope on interrupt', async () => {
    const runner = new FakeRunner();
    runner.enqueue(JSON.stringify({
      interrupted: true,
      kind: 'tasks',
      agentRunId: AGENT_RUN_ID,
      role: 'be',
    }));
    const r = await askUser.handler({ question: 'x?' }, ctx(runner));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('approve_subordinate_tasks');
    const envelope = JSON.parse(r.content.split('\n')[0]);
    expect(envelope.interrupted).toBe(true);
    expect(envelope.next_action).toBe('approve_subordinate_tasks');
    expect(envelope.agent_run_id).toBe(AGENT_RUN_ID);
  });
});

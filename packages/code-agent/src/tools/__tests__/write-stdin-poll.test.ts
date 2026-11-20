/**
 * write_stdin is classified by its input: an empty (or absent) `chars` is a
 * poll — read risk, pollable repetition — exactly like the retired
 * poll_session; non-empty `chars` stays an execute-risk mutating write. The
 * one deliberate difference: poll FAILURES still count toward the
 * failure-streak guard (session 798 rotated session ids through 13 failing
 * write_stdin calls), because the pollable policy is input-derived, not
 * declared by the tool. Repetition guards are diagnostic (a `shadow` verdict,
 * never a refusal); a poll must simply not be reported as a repeated write.
 */
import { describe, expect, it } from 'vitest';
import { ok, type CoderTool, type ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import {
  evaluateToolInvocation, isReadOnlySessionInvocation, readOnlySessionAuthority, resolveToolInvocationMetadata,
} from '@mcp/code-agent/core/policy.js';
import { declaresPolling } from '@mcp/code-agent/core/tool-classification.js';
import { classifyForGate } from '@mcp/code-agent/core/permission-gate.js';
import { buildNestedToolObserver } from '@mcp/code-agent/core/runner/guards/nested-observer.js';
import { emptyFailureStreakState } from '@mcp/code-agent/core/runner/guards/failure-streak.js';
import { invocationIsPollable } from '@mcp/code-agent/core/runner/nodes/executing-loop-guards.js';
import { execCommand, writeStdin } from '../exec-command.js';
import { buildCodeExecTool } from '../code-exec.js';

const POLLS = [{ session_id: 's' }, { session_id: 's', chars: '' }];
const WRITE = { session_id: 's', chars: 'q\n' };
const pick = (m: ReturnType<typeof resolveToolInvocationMetadata>) =>
  ({ riskLevel: m.riskLevel, mutates: m.mutates, executionClass: m.executionClass, repeatPolicy: m.repeatPolicy });

describe('write_stdin input classification', () => {
  it.each(POLLS)('an empty poll %j resolves as a read, pollable call', (input) => {
    expect(pick(resolveToolInvocationMetadata(writeStdin, input)))
      .toEqual({ riskLevel: 'read', mutates: false, executionClass: 'read', repeatPolicy: 'pollable' });
  });

  it('a write keeps its execute-risk mutating classification', () => {
    expect(pick(resolveToolInvocationMetadata(writeStdin, WRITE)))
      .toEqual({ riskLevel: 'execute', mutates: true, executionClass: 'execute', repeatPolicy: 'mutating' });
  });

  it('only a statically declared pollable policy exempts failures', () => {
    const waiting = { name: 'wait_x', description: 'w', source: 'native', repeatPolicy: 'pollable',
      parameters: { type: 'object', properties: {} }, handler: async () => ok('') } as CoderTool;
    expect(declaresPolling(writeStdin)).toBe(false);
    expect(declaresPolling(waiting)).toBe(true);
  });
});

describe('gates treat an empty write_stdin as a poll', () => {
  it('permission gate allows the poll and gates the write as execute', () => {
    for (const input of POLLS) expect(classifyForGate(writeStdin, 'write_stdin', input)).toBe('allow');
    expect(classifyForGate(writeStdin, 'write_stdin', WRITE)).toBe('execute');
  });

  it('plan mode lets the poll through and blocks the write', () => {
    const plan = { planMode: true, planApproved: false, taskScope: null };
    expect(evaluateToolInvocation(writeStdin, POLLS[0], plan).allowed).toBe(true);
    expect(evaluateToolInvocation(writeStdin, WRITE, plan)).toMatchObject({ allowed: false, reason: 'plan_mode' });
  });

  it('a read-only session neither publishes nor authorizes write_stdin without exec_command', () => {
    expect(isReadOnlySessionInvocation(writeStdin, POLLS[0])).toBe(true);
    expect(isReadOnlySessionInvocation(writeStdin, WRITE)).toBe(false);
    expect(readOnlySessionAuthority([execCommand, writeStdin]).map(t => t.name)).not.toContain('write_stdin');
    expect(writeStdin.continues).toEqual(['exec_command']);
  });

  it('nested dedup reports no repeated invocation for polls, and still flags repeated identical writes', () => {
    const run = (input: Record<string, unknown>) => {
      const observer = buildNestedToolObserver({ failureStreaks: emptyFailureStreakState(), turn: 1, parentToolUseId: 'p' });
      const { repeatPolicy } = resolveToolInvocationMetadata(writeStdin, input);
      return [1, 2, 3].map(() => observer.beforeNestedCall('write_stdin', input, { repeatPolicy })?.reason ?? null);
    };
    expect(run(POLLS[0])).toEqual([null, null, null]);
    // Unchanged for writes: the second identical write already gets the reminder verdict.
    expect(run(WRITE)).toEqual([null, 'repeated-invocation', 'repeated-invocation']);
  });

  it('the per-turn dominance guard exempts the poll by invocation, not by tool name', () => {
    const registry = new ToolRegistry();
    registry.register(writeStdin);
    expect(invocationIsPollable(registry, { name: 'write_stdin', input: POLLS[0] })).toBe(true);
    expect(invocationIsPollable(registry, { name: 'write_stdin', input: WRITE })).toBe(false);
    expect(invocationIsPollable(registry, { name: 'missing', input: {} })).toBe(false);
  });

  it('nested poll failures still build a failure streak', () => {
    const failureStreaks = emptyFailureStreakState();
    const observer = buildNestedToolObserver({ failureStreaks, turn: 1, parentToolUseId: 'p' });
    const opts = { repeatPolicy: 'pollable' as const, failureStreakExempt: false };
    for (let i = 0; i < 5; i++) {
      observer.afterNestedCall({ invocationId: `i${i}`, name: 'write_stdin', args: { session_id: `gone-${i}` },
        isError: true, durationMs: 0, resultChars: 20, resultPreview: `session gone-${i} not active`, ...opts });
    }
    expect(observer.beforeNestedCall('write_stdin', { session_id: 'gone-9' }, opts))
      .toMatchObject({ reason: 'failure-streak' });
    expect(observer.beforeNestedCall('write_stdin', { session_id: 'gone-9' }, { ...opts, failureStreakExempt: true }))
      .toBeNull();
  });
});

describe('code_exec nested polls', () => {
  async function run(chars: string, times: number) {
    const registry = new ToolRegistry();
    registry.register(writeStdin);
    const writes: string[] = [];
    const verdicts: Array<string | null> = [];
    const ctx = {
      cwd: process.cwd(), projectName: 'poll',
      ports: { commands: { write: async (i: { chars: string }) => { writes.push(i.chars); return ok('status=running'); } } },
      nestedToolObserver: buildNestedToolObserver({ failureStreaks: emptyFailureStreakState(), turn: 1, parentToolUseId: 'p',
        onNestedCall: (e) => verdicts.push(e.guardVerdict?.reason ?? null) }),
    } as unknown as ToolContext;
    const res = await buildCodeExecTool(registry).handler({ code:
      `for (let i = 0; i < ${times}; i++) await tools.write_stdin({ session_id: 's', chars: ${JSON.stringify(chars)} }); return 'done';` }, ctx);
    return { res, writes, verdicts };
  }

  it('repeats an identical empty poll without a repeated-invocation verdict', async () => {
    const { res, writes, verdicts } = await run('', 4);
    expect(res.isError).toBeFalsy();
    expect(writes).toEqual(['', '', '', '']);
    expect(verdicts).toEqual([null, null, null, null]);
  });

  it('still flags (without blocking) a third identical write', async () => {
    const { res, writes, verdicts } = await run('y', 3);
    expect(res.isError).toBeFalsy();
    expect(writes).toEqual(['y', 'y', 'y']);
    expect(verdicts.at(-1)).toBe('repeated-invocation');
  });
});

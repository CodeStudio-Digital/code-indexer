import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import { asSessionId } from '@mcp/session-storage';
import { hasOwnedCancellationReceipt, settleOwnedCancellation } from '@mcp/code-agent/runtime/native-cancellation-settlement.js';
import { NativeSessionReviewPort } from '../workers/native-session-review-port.js';

function fixture(checkOwner = () => {}) {
  const sessionId = asSessionId('00000000-0000-4000-8000-000000000001');
  const port = new NativeSessionReviewPort(sessionId, 'agent', 'D:\\fixture', checkOwner);
  const context: ToolContext = { sessionId, cwd: 'D:\\fixture', projectName: 'review-fixture',
    controlPlaneParentAgentRunId: 'agent', currentToolUseId: 'invocation',
    toolCallLedger: new ToolCallLedger(), ports: { sessionReview: port } };
  return { port, context, confirm: port.beginInvocation('invocation') };
}
afterEach(() => vi.useRealTimers());

describe('NativeSessionReviewPort cancellation receipts', () => {
  it('waits for the real invocation even when its terminal commit has already been acknowledged', async () => {
    const f = fixture(); let finish!: (value: ToolResult) => void, resolved = false;
    const invocation = new Promise<ToolResult>(resolve => { finish = resolve; });
    const pending = settleOwnedCancellation('self_review', f.context, invocation).then(value => { resolved = true; return value; });
    f.confirm({ runId: 'review-run' }); await Promise.resolve(); expect(resolved).toBe(false);
    finish({ content: 'cancelled', isError: true }); expect(await pending).toBe(true);
  });
  it('requires an exact invocation, session and agent owner after the terminal receipt', () => {
    const f = fixture(); f.confirm({ runId: 'review-run' });
    expect(hasOwnedCancellationReceipt('self_review', f.context)).toBe(true);
    for (const override of [{ currentToolUseId: 'other' }, { sessionId: asSessionId('00000000-0000-4000-8000-000000000002') }, { controlPlaneParentAgentRunId: 'other' }]) {
      expect(hasOwnedCancellationReceipt('self_review', { ...f.context, ...override })).toBe(false);
    }
    expect(hasOwnedCancellationReceipt('another_control_tool', f.context)).toBe(false);
  });
  it('does not reuse a receipt after owner retirement or a divergent terminal', () => {
    let active = true; const f = fixture(() => { if (!active) throw new Error('retired'); });
    f.confirm({ runId: 'review-run' }); active = false;
    expect(hasOwnedCancellationReceipt('self_review', f.context)).toBe(false);
    expect(() => f.confirm({ runId: 'review-run' })).toThrow('retired');
    active = true; expect(() => f.confirm({ runId: 'different-run' })).toThrow('diverged');
    expect(hasOwnedCancellationReceipt('self_review', f.context)).toBe(false);
  });
  it('preserves unknown nested effects and unknown settled results despite a terminal receipt', async () => {
    const f = fixture(); f.confirm({ runId: 'review-run' });
    expect(await settleOwnedCancellation('self_review', f.context,
      Promise.resolve({ content: 'lost ack', effectOutcome: 'unknown' }))).toBe(false);
    f.context.toolCallLedger!.markOutcomeUnknown('reference');
    expect(await settleOwnedCancellation('self_review', f.context, Promise.resolve({ content: 'cancelled' }))).toBe(false);
  });
  it('does not accept a handler error, timeout or missing terminal receipt as proof', async () => {
    const f = fixture();
    expect(await settleOwnedCancellation('self_review', f.context, Promise.reject(new Error('disk full')))).toBe(false);
    vi.useFakeTimers();
    const pending = settleOwnedCancellation('self_review', f.context, new Promise<ToolResult>(() => {}));
    await vi.advanceTimersByTimeAsync(10_000); expect(await pending).toBe(false);
    f.confirm({ runId: 'late-receipt' }); expect(await pending).toBe(false);
  });
  it('rejects repeated invocation admission and bounds malformed receipt identities', () => {
    const f = fixture(); expect(() => f.port.beginInvocation('invocation')).toThrow('repeated');
    expect(() => f.confirm({ runId: '' })).toThrow('durable run');
    expect(hasOwnedCancellationReceipt('self_review', f.context)).toBe(false);
  });
});

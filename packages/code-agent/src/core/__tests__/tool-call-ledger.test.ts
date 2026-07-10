import { describe, expect, it } from 'vitest';
import { ToolCallLedger, logicalOperationId } from '../tool-call-ledger.js';

describe('ToolCallLedger', () => {
  it('groups paginated slices into one logical operation', () => {
    expect(logicalOperationId('read_file', { path: 'a.ts', start_line: 1, end_line: 50 }))
      .toBe(logicalOperationId('read_file', { path: 'a.ts', start_line: 51, end_line: 100 }));
  });

  it('marks a new result productive and an identical polling continuation non-productive', () => {
    const ledger = new ToolCallLedger();
    const first = ledger.record({ name: 'mcp__search', args: { query: 'a', cursor: 'first' }, content: 'same', isError: false });
    const again = ledger.record({ name: 'mcp__search', args: { query: 'a', cursor: 'next' }, content: 'same', isError: false });
    expect(first.productive).toBe(true);
    expect(again.productive).toBe(false);
    expect(first.logicalOperationId).toBe(again.logicalOperationId);
  });

  it('tracks read coverage and treats a new range as productive', () => {
    const ledger = new ToolCallLedger();
    const first = ledger.record({
      name: 'read_file', args: { path: 'a.ts', start_line: 1, end_line: 20 }, content: 'same', isError: false,
    });
    const next = ledger.record({
      name: 'read_file', args: { path: 'a.ts', start_line: 21, end_line: 40 }, content: 'same', isError: false,
    });
    expect(first.readCoverage).toEqual({ path: 'a.ts', start: 1, end: 20 });
    expect(next.coverageNovel).toBe(true);
    expect(next.productive).toBe(true);
  });

  it('classifies permission refusals, timeouts and cancellation', () => {
    const ledger = new ToolCallLedger();
    expect(ledger.record({
      name: 'edit_file', args: {}, content: 'denied', isError: true, refusalKind: 'user_denied',
    }).outcome).toBe('refusal');
    expect(ledger.record({
      name: 'run_command', args: {}, content: 'timeout', isError: true, refusalKind: 'timeout',
    }).outcome).toBe('timeout');
    expect(ledger.record({
      name: 'run_command', args: { n: 2 }, content: 'abort', isError: true, refusalKind: 'abort',
    }).outcome).toBe('cancelled');
  });

  it('holds the shared unsafe lane until the owner explicitly releases it', async () => {
    const ledger = new ToolCallLedger();
    const releaseFirst = await ledger.reserveUnsafe();
    let secondAcquired = false;
    const second = ledger.reserveUnsafe().then((release) => {
      secondAcquired = true;
      release();
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    releaseFirst();
    await second;
    expect(secondAcquired).toBe(true);
  });
});

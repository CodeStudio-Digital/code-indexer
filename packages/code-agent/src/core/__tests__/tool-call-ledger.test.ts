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

  it('retains only allowlisted validation labels, not raw shell arguments', () => {
    const ledger = new ToolCallLedger();
    const validation = ledger.record({
      name: 'run_command',
      args: { command: 'npm run typecheck -- --pretty false' },
      content: 'ok',
      isError: false,
    });
    const unrelated = ledger.record({
      name: 'run_command',
      args: { command: 'deploy --token very-secret-value' },
      content: 'ok',
      isError: false,
    });
    expect(validation.validationSignal).toBe('npm run typecheck');
    expect(unrelated.validationSignal).toBeUndefined();
    expect(JSON.stringify(ledger.snapshot())).not.toContain('very-secret-value');
  });

  it('refuses only after repeated identical no-progress results', () => {
    const ledger = new ToolCallLedger();
    const input = { name: 'search', args: { query: 'same' }, content: 'unchanged', isError: false };
    for (let i = 0; i < 4; i++) {
      expect(ledger.checkRepeat({ name: input.name, args: input.args })).toBeNull();
      ledger.record(input);
    }
    expect(ledger.checkRepeat({ name: input.name, args: input.args })).toMatchObject({ count: 4 });
  });

  it('allows polling, mutations, pagination coverage and genuinely new results', () => {
    const pollable = new ToolCallLedger();
    for (let i = 0; i < 8; i++) {
      pollable.record({ name: 'poll_status', args: { id: 1 }, content: 'pending', isError: false, repeatPolicy: 'pollable' });
    }
    expect(pollable.checkRepeat({ name: 'poll_status', args: { id: 1 }, repeatPolicy: 'pollable' })).toBeNull();

    const mutation = new ToolCallLedger();
    for (let i = 0; i < 8; i++) {
      mutation.record({ name: 'write_file', args: { path: 'a.ts' }, content: 'ok', isError: false, mutates: true });
    }
    expect(mutation.checkRepeat({ name: 'write_file', args: { path: 'a.ts' }, mutates: true })).toBeNull();

    const paginated = new ToolCallLedger();
    for (let page = 0; page < 8; page++) {
      paginated.record({
        name: 'read_file',
        args: { path: 'a.ts', start_line: page * 20 + 1, end_line: page * 20 + 20 },
        content: 'same boilerplate',
        isError: false,
      });
    }
    expect(paginated.checkRepeat({ name: 'read_file', args: { path: 'a.ts', start_line: 161, end_line: 180 } })).toBeNull();

    const changing = new ToolCallLedger();
    for (let i = 0; i < 8; i++) {
      changing.record({ name: 'search', args: { query: 'q' }, content: `result-${i}`, isError: false });
    }
    expect(changing.checkRepeat({ name: 'search', args: { query: 'q' } })).toBeNull();
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

  it('cancels a queued unsafe reservation without breaking FIFO release', async () => {
    const ledger = new ToolCallLedger();
    const releaseFirst = await ledger.reserveUnsafe();
    const controller = new AbortController();
    const queued = ledger.reserveUnsafe(controller.signal);
    controller.abort(new Error('deadline'));
    await expect(queued).rejects.toThrow('deadline');

    let thirdAcquired = false;
    const third = ledger.reserveUnsafe().then((release) => {
      thirdAcquired = true;
      release();
    });
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
    releaseFirst();
    await third;
    expect(thirdAcquired).toBe(true);
  });
});

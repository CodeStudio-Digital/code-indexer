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

  it('keeps package validation scripts distinct and recognizes audit checks', () => {
    const ledger = new ToolCallLedger();
    const loc = ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run check:loc -- --details' },
      content: 'failed',
      isError: true,
    });
    const env = ledger.record({
      name: 'run_command',
      args: { command: 'pnpm run audit:env:check' },
      content: 'failed',
      isError: true,
    });
    expect(loc.validationSignal).toBe('pnpm run check:loc');
    expect(env.validationSignal).toBe('pnpm run audit:env:check');
  });

  it('recognizes validation scripts after monorepo workspace selectors', () => {
    const ledger = new ToolCallLedger();
    const test = ledger.record({
      name: 'run_command',
      args: { command: 'pnpm --filter @migrator/core test -- siger.mapper.spec.ts' },
      content: 'passed',
      isError: false,
    });
    const typecheck = ledger.record({
      name: 'run_command',
      args: { command: 'npm --workspace apps/api run typecheck -- --pretty false' },
      content: 'passed',
      isError: false,
    });
    const unrelated = ledger.record({
      name: 'run_command',
      args: { command: 'pnpm --filter test deploy' },
      content: 'deployed',
      isError: false,
    });

    expect(test.validationSignal).toBe('pnpm test');
    expect(typecheck.validationSignal).toBe('npm run typecheck');
    expect(unrelated.validationSignal).toBeUndefined();
    expect(JSON.stringify(ledger.snapshot())).not.toContain('@migrator');
  });

  it('recognizes PHP syntax checks without retaining the target path', () => {
    const ledger = new ToolCallLedger();
    const lint = ledger.record({
      name: 'run_command',
      args: { command: 'php -l sync-service/handlers/UserHandler.php' },
      content: 'No syntax errors detected',
      isError: false,
    });

    expect(lint.validationSignal).toBe('php -l');
    expect(JSON.stringify(ledger.snapshot())).not.toContain('UserHandler.php');
  });

  it('correlates spawn recovery by a hashed opaque id across tools', () => {
    const ledger = new ToolCallLedger();
    const spawnId = 'spawn-private-control-id';
    const failed = ledger.record({
      name: 'spawn_agent',
      args: { task: 'inspect streaming' },
      content: 'partial',
      isError: true,
      structuredData: { kind: 'spawn_agent_result', status: 'partial', spawnId },
    });
    const recovered = ledger.record({
      name: 'resume_agent',
      args: { spawn_id: spawnId },
      content: 'completed',
      isError: false,
      structuredData: { kind: 'resume_agent_result', status: 'completed', spawnId },
    });
    const unrelated = ledger.record({
      name: 'resume_agent',
      args: { spawn_id: 'different-spawn' },
      content: 'completed',
      isError: false,
    });

    expect(failed.recoveryOperationId).toBe(recovered.recoveryOperationId);
    expect(unrelated.recoveryOperationId).not.toBe(failed.recoveryOperationId);
    expect(JSON.stringify(ledger.snapshot())).not.toContain(spawnId);
  });

  it('ignores recovery-looking fields outside the allowlisted result shape', () => {
    const ledger = new ToolCallLedger();
    const entry = ledger.record({
      name: 'spawn_agent',
      args: { task: 'inspect' },
      content: 'plugin-shaped result',
      isError: true,
      structuredData: {
        kind: 'third_party_payload',
        spawnId: 'must-not-correlate',
      },
    });
    expect(entry.recoveryOperationId).toBeUndefined();
    expect(JSON.stringify(ledger.snapshot())).not.toContain('must-not-correlate');
  });

  it('correlates a resumed workflow without retaining its raw workflow id', () => {
    const ledger = new ToolCallLedger();
    const workflowId = 'wf_private_control_id';
    const failed = ledger.record({
      name: 'workflow',
      args: { steps: [{ id: 'one' }] },
      content: 'failed',
      isError: true,
      structuredData: { kind: 'workflow_result', status: 'failed', workflowId },
    });
    const recovered = ledger.record({
      name: 'workflow',
      args: { resume_workflow_id: workflowId, retry_failed: true },
      content: 'completed',
      isError: false,
    });

    expect(failed.recoveryOperationId).toBe(recovered.recoveryOperationId);
    expect(JSON.stringify(ledger.snapshot())).not.toContain(workflowId);
  });

  it('records only the selected structured out-of-scope validation decision', () => {
    const ledger = new ToolCallLedger();
    const args = {
      question: 'May failed baseline validation be treated as out of scope?',
      options: [
        {
          label: 'Complete — drift is out of scope',
          value: 'complete',
          goal_lifecycle_resolution: 'accept_out_of_scope_validation',
        },
        { label: 'Keep working', value: 'retry' },
      ],
    };
    expect(ledger.record({
      name: 'ask_user',
      args,
      content: 'User answered: complete',
      isError: false,
    }).goalLifecycleResolution).toBe('accept_out_of_scope_validation');
    expect(ledger.record({
      name: 'ask_user',
      args,
      content: 'User answered: retry',
      isError: false,
    }).goalLifecycleResolution).toBeUndefined();
  });

  it('recognizes the released complete_out_of_scope option without retaining its prose', () => {
    const ledger = new ToolCallLedger();
    const entry = ledger.record({
      name: 'ask_user',
      args: {
        question: 'Como proceder com o drift fora de escopo?',
        options: [
          { label: 'Concluir — drift é fora de escopo', value: 'complete_out_of_scope' },
          { label: 'Continuar', value: 'continue' },
        ],
      },
      content: 'User answered: complete_out_of_scope',
      isError: false,
    });
    expect(entry.goalLifecycleResolution).toBe('accept_out_of_scope_validation');
    expect(JSON.stringify(ledger.snapshot())).not.toContain('Como proceder');
    expect(JSON.stringify(ledger.snapshot())).not.toContain('complete_out_of_scope');
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

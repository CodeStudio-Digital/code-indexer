import { describe, expect, it } from 'vitest';
import { ToolCallLedger, logicalOperationId, extractValidationSignal } from '../tool-call-ledger.js';

describe('validation command recognition', () => {
  it('recognizes structured shell checks and rejects ambiguous or token-spoofed argv', () => {
    expect(extractValidationSignal('exec_command', { command: {
      kind: 'shell', shell: 'cmd', script: 'npm run build && node node_modules/typescript/bin/tsc --noEmit',
    } })).toBe('npm run build && tsc --noEmit');
    for (const args of [
      { command: { kind: 'argv', executable: 'npm test', args: [] } },
      { command: { kind: 'argv', executable: 'npm', args: ['run test'] } },
      { command: { kind: 'argv', executable: 'npm', args: ['test', '&&', 'echo'] } },
      { command: { kind: 'argv', executable: 'npm', args: ['test'] }, cmd: 'echo done' },
      { command: { kind: 'shell', shell: 'unknown', script: 'npm test' } },
    ]) expect(extractValidationSignal('exec_command', args)).toBeUndefined();
  });

  it.each([
    'git diff --output=source.ts',
    'git diff > source.ts',
    'git diff --check && node rewrite.js',
    'git -c alias.inspect=reset inspect',
    'git diff --ext-diff',
    'git diff --textconv',
    'git status; git reset --hard',
    'git status | tee source.ts',
    'node --version && node -e "process.exit(0)"',
    'node --version > source.ts',
  ])('keeps potentially mutating commands outside inspection evidence: %s', cmd => {
    const ledger = new ToolCallLedger();
    expect(ledger.record({ name: 'exec_command', args: { cmd }, content: 'ok', isError: false }).verificationObservation).toBeUndefined();
  });

  it.each([
    'Get-Content result.log; Set-Content source.ts changed',
    'Get-Content result.log > source.ts',
    'Get-Content $(Write-Output result.log)',
    'Get-Content result.log | Invoke-Expression',
  ])('does not treat an arbitrary PowerShell script as inspection: %s', script => {
    const ledger = new ToolCallLedger();
    expect(ledger.record({ name: 'exec_command', args: { command: {
      kind: 'argv', executable: 'powershell', args: ['-NoProfile', '-Command', script],
    } }, content: 'ok', isError: false }).verificationObservation).toBeUndefined();
  });

  it('does not certify inspection as a test or retain raw command input', () => {
    const ledger = new ToolCallLedger();
    const entry = ledger.record({ name: 'exec_command', args: { command: {
      kind: 'argv', executable: 'git', args: ['diff', '--', 'private-file.ts'],
    } }, content: 'ok', isError: false });
    expect(entry.verificationObservation).toBe(true);
    expect(entry.validationSignal).toBeUndefined();
    expect(JSON.stringify(ledger.snapshot())).not.toContain('private-file.ts');
    expect(ledger.record({ name: 'plugin_shell', args: { cmd: 'git status' }, content: 'ok', isError: false }).verificationObservation).toBeUndefined();
  });

  it.each([
    'echo "npm test"',
    '"pnpm test"',
    'pnpm "run test"',
    'printf "pytest passed"',
    'cat build.log',
    'npm test -- --help',
    'pnpm test --dry-run',
    'npx jest --listTests',
    'pytest --collect-only',
    'npx tsc -v',
    'pnpm test || echo success',
    'echo before; pnpm test',
    'pnpm test >',
    'pnpm test | tee result.txt',
    'npm run build && echo success',
    'node -e "console.log(0)"',
    'node node_modules/ava/entrypoints/cli.mjs --help > result.txt',
    'pnpm --dir ../other test',
  ])('does not mistake %s for completed validation', (command) => {
    expect(extractValidationSignal('run_command', { command })).toBeUndefined();
  });

  it('keeps verbose direct checks and explicit shell working directories valid', () => {
    expect(extractValidationSignal('exec_command', { cmd: 'pytest -v', workdir: '/repo' })).toBe('pytest');
    expect(extractValidationSignal('run_command', { command: 'pytest -c pytest.ini' })).toBe('pytest');
    expect(extractValidationSignal('run_command', { command: 'npx tsc --noEmit' })).toBe('tsc --noEmit');
  });

  it.each([
    ['pnpm test > result.txt', 'pnpm test'],
    ['node node_modules/ava/entrypoints/cli.mjs "test/*.ts" "!test/browser.ts" > .checks.log 2>&1', 'ava'],
    ['npm run build && node node_modules/typescript/bin/tsc --project tsconfig.test.json', 'npm run build && tsc --noEmit'],
    ['node_modules\\.bin\\xo.cmd src/a.ts > "lint results.log" 2>&1', 'static validation'],
    ['pytest -v 1> test.log 2>&1', 'pytest'],
  ])('recognizes completed validation with its real launcher and log: %s', (command: string, expected: string) => {
    expect(extractValidationSignal('run_command', { command })).toBe(expected);
    const ledger = new ToolCallLedger();
    expect(ledger.record({ name: 'run_command', args: { command }, content: 'exit code: 1', isError: true }).validationOutcome).toBe('failed');
  });

  it('retains only a documentation classification, not report contents', () => {
    const ledger = new ToolCallLedger();
    const entry = ledger.record({ name: 'write_file', args: { path: 'REPORT.md', content: 'private-prose' }, content: 'ok', isError: false, mutates: true });
    expect(entry.documentationOnly).toBe(true);
    expect(JSON.stringify(ledger.snapshot())).not.toContain('private-prose');
  });

  it('does not trust arbitrary tool names or command-looking read arguments', () => {
    expect(extractValidationSignal('read_file', { command: 'npm test' })).toBeUndefined();
    expect(extractValidationSignal('plugin_build', {})).toBeUndefined();
  });
});

describe('ToolCallLedger', () => {
  it('keeps semantic date bounds and nested pagination-named filters distinct', () => {
    for (const field of ['start', 'end', 'before', 'after']) {
      expect(logicalOperationId('query', { [field]: '2025' })).not.toBe(logicalOperationId('query', { [field]: '2026' }));
    }
    expect(logicalOperationId('query', { filter: { page: 1, start: '2025' } }))
      .not.toBe(logicalOperationId('query', { filter: { page: 2, start: '2026' } }));
  });

  it('invalidates stale read observations after a successful edit', () => {
    const ledger = new ToolCallLedger();
    const input = { name: 'read_file', args: { path: 'a.ts' }, content: 'snapshot', isError: false };
    for (let i = 0; i < 5; i++) ledger.record(input);
    expect(ledger.checkRepeat(input)).not.toBeNull();
    ledger.record({ name: 'edit_file', args: { path: 'a.ts' }, content: 'updated', isError: false, mutates: true });
    expect(ledger.checkRepeat(input)).toBeNull();
    expect(ledger.record(input).productive).toBe(true);
    expect(ledger.snapshot()).toHaveLength(7);
  });
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

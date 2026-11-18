import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { evaluateVerificationReadinessAtFinish, maybeVerificationNudge } from '../executing-verification-gate.js';
import { makeTestContext } from './test-helpers.js';

function registerTool(
  registry: ToolRegistry,
  name: string,
  metadata: Partial<Pick<CoderTool, 'mutates' | 'riskLevel' | 'executionClass'>> = {},
): void {
  registry.register({
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    source: 'native',
    ...metadata,
    handler: async () => ({ content: 'ok' }),
  });
}

function harness(changedFiles: string[] = ['src/a.ts']) {
  const ledger = new ToolCallLedger();
  const registry = new ToolRegistry();
  registerTool(registry, 'edit_file', {
    mutates: true,
    riskLevel: 'write',
    executionClass: 'write',
  });
  registerTool(registry, 'run_command', {
    mutates: false,
    riskLevel: 'execute',
    executionClass: 'execute',
  });
  for (const name of ['exec_command', 'write_stdin']) {
    registerTool(registry, name, { mutates: true, riskLevel: 'execute', executionClass: 'execute' });
  }
  registerTool(registry, 'poll_session', { mutates: false, riskLevel: 'read', executionClass: 'read' });
  const { ctx } = makeTestContext({
    registry,
    toolContext: {
      cwd: process.cwd(),
      projectName: 'verification-gate-test',
      toolCallLedger: ledger,
    } as ToolContext,
  });
  ctx.bridge = {
    getSessionStateData: () => ({
      activePlan: null,
      todos: [],
      notes: [],
      filesChanged: changedFiles,
      investigationCount: 0,
    }),
  };
  return { ctx, ledger };
}

function write(ledger: ToolCallLedger, path = 'src/a.ts') {
  ledger.record({
    name: 'edit_file',
    args: { path },
    content: 'edited',
    isError: false,
    mutates: true,
    executionClass: 'write',
  });
}

function validate(
  ledger: ToolCallLedger,
  isError = false,
  command = 'pnpm test',
) {
  ledger.record({
    name: 'run_command',
    args: { command },
    content: isError ? 'exit code 1' : 'exit code 0',
    isError,
    executionClass: 'execute',
  });
}

describe('evaluateVerificationReadinessAtFinish', () => {
  it('keeps verification fresh through the final inspection/report sequence from the Ky benchmark', async () => {
    const { ctx, ledger } = harness(['src/a.ts', 'BENCHMARK_RESULT.md']);
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    const inspect = (args: Record<string, unknown>) => ledger.record({
      name: 'exec_command', args, content: 'inspection', isError: false,
      executionClass: 'execute', mutates: true,
      structuredData: { state: 'exited', exitCode: 0 },
    });
    inspect({ cmd: 'git diff --check && git diff -- source/a.ts && git status --short' });
    inspect({ command: { kind: 'argv', executable: 'powershell', args: [
      '-NoProfile', '-Command', 'Get-Content .benchmark-build.log; Get-Content .benchmark-full-tests.log -Tail 8',
    ] } });
    terminal(ledger, 'write_stdin', 'exited', 0);
    inspect({ cmd: 'node --version && git diff --check && git diff --numstat && git diff -- test/retry-timing.ts' });
    write(ledger, 'BENCHMARK_RESULT.md');
    const readiness = await evaluateVerificationReadinessAtFinish(ctx);
    expect(readiness).toMatchObject({ status: 'fresh', lastWriteSeq: 1, lastSuccessfulValidationSeq: 5 });
    expect(maybeVerificationNudge(ctx, readiness)).toBeNull();
    // Inspection must not weaken the execution or permission classification.
    expect(ledger.snapshot()[2]).toMatchObject({ executionClass: 'execute', mutates: true });
  });

  it('recognizes structured argv checks without accepting the shell launch as a passed check', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    ledger.record({ name: 'exec_command', args: { command: {
      kind: 'argv', executable: 'node', args: ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.test.json'],
    } }, content: 'running', isError: false, mutates: true, executionClass: 'execute',
    structuredData: { sessionId: 'terminal-a', state: 'running', exitCode: null } });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('fresh');
  });

  it('correlates empty inspection polls but invalidates freshness after interactive input', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    ledger.record({ name: 'exec_command', args: { cmd: 'git diff --stat' }, content: 'running',
      isError: false, executionClass: 'execute', mutates: true,
      structuredData: { sessionId: 'inspection', state: 'running' } });
    terminal(ledger, 'write_stdin', 'running', null, { sessionId: 'inspection' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('fresh');
    terminal(ledger, 'write_stdin', 'running', null, { sessionId: 'inspection', chars: 'new command\n' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0, { sessionId: 'inspection' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it.each(['node rewrite.js', 'git diff > src/a.ts', 'git reset --hard'])('still requires verification after %s', cmd => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    ledger.record({ name: 'exec_command', args: { cmd }, content: 'exited', isError: false,
      mutates: true, executionClass: 'execute', structuredData: { state: 'exited', exitCode: 0 } });
    return expect(evaluateVerificationReadinessAtFinish(ctx)).resolves.toMatchObject({ status: 'stale' });
  });

  it('invalidates an explicit documentation check when documentation changes', async () => {
    const { ctx, ledger } = harness(['docs/guide.md']);
    validate(ledger, false, 'pnpm run lint:docs');
    write(ledger, 'docs/guide.md');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
    validate(ledger, false, 'pnpm run lint:docs');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('fresh');
  });

  it.each(['pnpm test', 'pnpm run lint:docs'])('applies documentation scope to persisted checks: %s', async command => {
    const { ctx } = harness(['src/a.ts', 'REPORT.md']);
    ctx.opts.collectVerifyEvidence = () => ({
      lastVerify: { command, at: '2026-11-11 01:00:00', isError: false, exitCode: 0 },
      verifyCount: 1, filesEditedAfter: ['REPORT.md'], filesEditedAtSameTime: [],
    });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe(command.includes('docs') ? 'stale' : 'fresh');
  });

  function terminal(ledger: ToolCallLedger, name: string, state: string, exitCode: number | null,
    extras: { sessionId?: string; chars?: string; isError?: boolean; refusalKind?: string } = {}) {
    const sessionId = extras.sessionId ?? 'terminal-a';
    ledger.record({ name,
      args: name === 'exec_command' ? { cmd: 'pnpm test' } : { session_id: sessionId, chars: extras.chars ?? '' },
      content: `status=${state}`, isError: extras.isError ?? false, refusalKind: extras.refusalKind,
      executionClass: 'execute', mutates: true,
      structuredData: { sessionId, state, exitCode },
    });
  }

  it('requires an exited zero receipt, correlated to the original terminal', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
    terminal(ledger, 'poll_session', 'exited', 0, { sessionId: 'unrelated' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('fresh');
  });

  it.each([
    { state: 'exited', exitCode: 1 },
    { state: 'exited', exitCode: null },
    { state: 'stopping', exitCode: null },
    { state: 'running', exitCode: null, isError: true, refusalKind: 'timeout' },
    { state: 'running', exitCode: null, isError: true, refusalKind: 'abort' },
  ])('does not certify a non-successful terminal receipt: %j', async (result) => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    terminal(ledger, 'write_stdin', result.state, result.exitCode, result);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('does not certify edits made while validation was running', async () => {
    const { ctx, ledger } = harness();
    terminal(ledger, 'exec_command', 'running', null);
    write(ledger);
    terminal(ledger, 'poll_session', 'exited', 0);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('invalidates correlation when interactive stdin can change the command', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    terminal(ledger, 'write_stdin', 'exited', 0, { chars: 'echo success\n' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('keeps resumed validation without a terminal exit code ambiguous', async () => {
    const { ctx } = harness();
    ctx.opts.collectVerifyEvidence = () => ({
      lastVerify: { command: 'pnpm test', at: '2026-07-23 10:00:00', isError: false, exitCode: null },
      verifyCount: 1, filesEditedAfter: [], filesEditedAtSameTime: [],
    });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('ambiguous');
  });

  it('is not applicable when no files or writes exist', async () => {
    const { ctx } = harness([]);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe(
      'not_applicable',
    );
  });

  it('reports missing after a write with no validation', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'missing',
      source: 'ledger',
      lastWriteSeq: 1,
    });
  });

  it('reports stale when validation precedes the latest write', async () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    write(ledger);
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'stale',
      lastValidationSeq: 1,
      lastWriteSeq: 2,
    });
  });

  it('does not repeat code checks after writing a report', async () => {
    const { ctx, ledger } = harness(['src/a.ts', 'REPORT.md']);
    write(ledger);
    validate(ledger, false, 'node node_modules/typescript/bin/tsc --project tsconfig.test.json > .types.log 2>&1');
    write(ledger, 'REPORT.md');
    const readiness = await evaluateVerificationReadinessAtFinish(ctx);
    expect(readiness.status).toBe('fresh');
    expect(readiness.lastWriteSeq).toBe(1);
    expect(maybeVerificationNudge(ctx, readiness)).toBeNull();
  });

  it('does not request code execution for a documentation-only task', async () => {
    const { ctx, ledger } = harness(['docs/usage.md']);
    write(ledger, 'docs/usage.md');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('not_applicable');
  });

  it.each(['src/prompts/system.md', 'docs/data.json', 'README.mdx', '../REPORT.md'])('does not exempt code or uncertain paths: %s', async (path: string) => {
    const { ctx, ledger } = harness([path]);
    validate(ledger);
    write(ledger, path);
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('keeps mixed code/documentation patches subject to validation', async () => {
    const { ctx, ledger } = harness(['src/a.ts', 'REPORT.md']);
    validate(ledger);
    ledger.record({ name: 'apply_patch', args: { _raw: '*** Begin Patch\n*** Update File: REPORT.md\n@@\n-old\n+new\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' }, content: 'updated', isError: false, mutates: true, executionClass: 'write' });
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('keeps failures visible after a documentation write', async () => {
    const { ctx, ledger } = harness(['src/a.ts', 'REPORT.md']);
    write(ledger);
    validate(ledger, true, 'pnpm test > tests.log 2>&1');
    write(ledger, 'REPORT.md');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('stale');
  });

  it('reports stale when the post-write validation failed', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, true);
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'stale',
      lastSuccessfulValidationSeq: null,
      lastValidationSeq: 2,
    });
  });

  it('invalidates an earlier success when the latest validation fails', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    validate(ledger, true, 'pnpm run build');
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'stale', lastSuccessfulValidationSeq: 2, lastValidationSeq: 3,
    });
    validate(ledger, false, 'pnpm run build');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('fresh');
  });

  it('does not accept echoed test text as verification after a write', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, false, 'echo "npm test"');
    expect((await evaluateVerificationReadinessAtFinish(ctx)).status).toBe('missing');
  });

  it('reports fresh when successful validation follows the latest write', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'fresh',
      lastWriteSeq: 1,
      lastSuccessfulValidationSeq: 2,
      validationSignals: ['pnpm test'],
    });
  });

  it('reports fresh for filtered workspace validation and PHP lint', async () => {
    const workspace = harness();
    write(workspace.ledger);
    validate(
      workspace.ledger,
      false,
      'pnpm --filter @migrator/core test -- siger.mapper.spec.ts',
    );
    expect(await evaluateVerificationReadinessAtFinish(workspace.ctx)).toMatchObject({
      status: 'fresh',
      validationSignals: ['pnpm test'],
    });

    const php = harness(['sync-service/handlers/UserHandler.php']);
    write(php.ledger, 'sync-service/handlers/UserHandler.php');
    validate(php.ledger, false, 'php -l sync-service/handlers/UserHandler.php');
    expect(await evaluateVerificationReadinessAtFinish(php.ctx)).toMatchObject({
      status: 'fresh',
      validationSignals: ['php -l'],
    });
  });

  it('accepts a successful current-run validation for resumed changed files', async () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'fresh',
      source: 'ledger',
      lastWriteSeq: null,
      lastSuccessfulValidationSeq: 1,
    });
  });

  it('uses persisted evidence on a resumed run with no current-run write', async () => {
    const { ctx } = harness();
    ctx.opts.collectVerifyEvidence = () => ({
      lastVerify: {
        command: 'pnpm test',
        at: '2026-07-23 10:00:00',
        isError: false,
        exitCode: 0,
      },
      verifyCount: 1,
      filesEditedAfter: [],
      filesEditedAtSameTime: ['src/a.ts'],
    });
    expect(await evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'ambiguous',
      source: 'persisted',
    });
  });

  it('nudges exactly once after a write without fresh validation', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    const readiness = await evaluateVerificationReadinessAtFinish(ctx);

    expect(maybeVerificationNudge(ctx, readiness)).toContain('[verification-required]');
    expect(maybeVerificationNudge(ctx, readiness)).toBeNull();
    expect(ctx.verification.nudges).toBe(1);
  });

  it('does not nudge read-only work or a write with fresh validation', async () => {
    const readOnly = harness([]);
    const readOnlyReadiness = await evaluateVerificationReadinessAtFinish(readOnly.ctx);
    expect(maybeVerificationNudge(readOnly.ctx, readOnlyReadiness)).toBeNull();

    const verified = harness();
    write(verified.ledger);
    validate(verified.ledger);
    const verifiedReadiness = await evaluateVerificationReadinessAtFinish(verified.ctx);
    expect(maybeVerificationNudge(verified.ctx, verifiedReadiness)).toBeNull();
    expect(verified.ctx.verification.nudges).toBe(0);
  });
});

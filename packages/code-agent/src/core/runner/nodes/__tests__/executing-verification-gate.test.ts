import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { evaluateVerificationReadiness, renderVerificationReminder } from '../executing-verification-gate.js';
import { resolveToolInvocationMetadata } from '@mcp/code-agent/core/policy.js';
import { writeStdin } from '@mcp/code-agent/tools/exec-command.js';
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

function harness() {
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
  const { ctx } = makeTestContext({
    registry,
    toolContext: {
      cwd: process.cwd(),
      projectName: 'verification-gate-test',
      toolCallLedger: ledger,
    } as ToolContext,
  });
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

describe('evaluateVerificationReadiness', () => {
  it('keeps verification fresh through the final inspection/report sequence from the Ky benchmark', () => {
    const { ctx, ledger } = harness();
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
    const readiness = evaluateVerificationReadiness(ctx);
    expect(readiness).toMatchObject({ status: 'fresh', lastWriteSeq: 1, lastSuccessfulValidationSeq: 5 });
    expect(renderVerificationReminder(readiness)).toBeNull();
    // Inspection must not weaken the execution or permission classification.
    expect(ledger.snapshot()[2]).toMatchObject({ executionClass: 'execute', mutates: true });
  });

  it('recognizes structured argv checks without accepting the shell launch as a passed check', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    ledger.record({ name: 'exec_command', args: { command: {
      kind: 'argv', executable: 'node', args: ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.test.json'],
    } }, content: 'running', isError: false, mutates: true, executionClass: 'execute',
    structuredData: { sessionId: 'terminal-a', state: 'running', exitCode: null } });
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0);
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });

  it('correlates empty inspection polls but invalidates freshness after interactive input', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    ledger.record({ name: 'exec_command', args: { cmd: 'git diff --stat' }, content: 'running',
      isError: false, executionClass: 'execute', mutates: true,
      structuredData: { sessionId: 'inspection', state: 'running' } });
    terminal(ledger, 'write_stdin', 'running', null, { sessionId: 'inspection' });
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
    terminal(ledger, 'write_stdin', 'running', null, { sessionId: 'inspection', chars: 'new command\n' });
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0, { sessionId: 'inspection' });
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it.each(['node rewrite.js', 'git diff > src/a.ts', 'git reset --hard'])('still requires verification after %s', cmd => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    ledger.record({ name: 'exec_command', args: { cmd }, content: 'exited', isError: false,
      mutates: true, executionClass: 'execute', structuredData: { state: 'exited', exitCode: 0 } });
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({ status: 'stale' });
  });

  it('invalidates an explicit documentation check when documentation changes', () => {
    const { ctx, ledger } = harness();
    validate(ledger, false, 'pnpm run lint:docs');
    write(ledger, 'docs/guide.md');
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
    validate(ledger, false, 'pnpm run lint:docs');
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });

  function terminal(ledger: ToolCallLedger, name: string, state: string, exitCode: number | null,
    extras: { sessionId?: string; chars?: string; isError?: boolean; refusalKind?: string } = {}) {
    const sessionId = extras.sessionId ?? 'terminal-a';
    const args = name === 'exec_command' ? { cmd: 'pnpm test' } : { session_id: sessionId, chars: extras.chars ?? '' };
    // Recorded as dispatch records it: write_stdin is classified by its input
    // (an empty poll is a read, as the retired poll_session was).
    const { executionClass, mutates } = name === 'write_stdin'
      ? resolveToolInvocationMetadata(writeStdin, args)
      : { executionClass: 'execute', mutates: true };
    ledger.record({ name, args,
      content: `status=${state}`, isError: extras.isError ?? false, refusalKind: extras.refusalKind,
      executionClass, mutates,
      structuredData: { sessionId, state, exitCode },
    });
  }

  it('requires an exited zero receipt, correlated to the original terminal', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0, { sessionId: 'unrelated' }); // empty poll (formerly poll_session)
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
    terminal(ledger, 'write_stdin', 'exited', 0);
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });

  it.each([
    { state: 'exited', exitCode: 1 },
    { state: 'exited', exitCode: null },
    { state: 'stopping', exitCode: null },
    { state: 'running', exitCode: null, isError: true, refusalKind: 'timeout' },
    { state: 'running', exitCode: null, isError: true, refusalKind: 'abort' },
  ])('does not certify a non-successful terminal receipt: %j', (result) => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    terminal(ledger, 'write_stdin', result.state, result.exitCode, result);
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('does not certify edits made while validation was running', () => {
    const { ctx, ledger } = harness();
    terminal(ledger, 'exec_command', 'running', null);
    write(ledger);
    terminal(ledger, 'write_stdin', 'exited', 0); // empty poll (formerly poll_session)
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('does not count an empty write_stdin poll, recorded with its invocation metadata, as a later write', () => {
    const poll = (ledger: ToolCallLedger, meta: { mutates: boolean; executionClass: string }) => ledger.record({
      name: 'write_stdin', args: { session_id: 'idle' }, content: 'status=running', isError: false, ...meta });
    const before = harness();
    write(before.ledger);
    validate(before.ledger);
    poll(before.ledger, { mutates: true, executionClass: 'execute' }); // the old static classification
    expect(evaluateVerificationReadiness(before.ctx).status).toBe('stale');
    const after = harness();
    write(after.ledger);
    validate(after.ledger);
    poll(after.ledger, resolveToolInvocationMetadata(writeStdin, { session_id: 'idle' }));
    expect(evaluateVerificationReadiness(after.ctx).status).toBe('fresh');
  });

  it('invalidates correlation when interactive stdin can change the command', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    terminal(ledger, 'exec_command', 'running', null);
    terminal(ledger, 'write_stdin', 'exited', 0, { chars: 'echo success\n' });
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('is not applicable when no files or writes exist', () => {
    const { ctx } = harness();
    expect(evaluateVerificationReadiness(ctx).status).toBe(
      'not_applicable',
    );
  });

  it('reports missing after a write with no validation', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'missing',
      source: 'ledger',
      lastWriteSeq: 1,
    });
  });

  it('reports stale when validation precedes the latest write', () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    write(ledger);
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'stale',
      lastValidationSeq: 1,
      lastWriteSeq: 2,
    });
  });

  it('does not repeat code checks after writing a report', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, false, 'node node_modules/typescript/bin/tsc --project tsconfig.test.json > .types.log 2>&1');
    write(ledger, 'REPORT.md');
    const readiness = evaluateVerificationReadiness(ctx);
    expect(readiness.status).toBe('fresh');
    expect(readiness.lastWriteSeq).toBe(1);
    expect(renderVerificationReminder(readiness)).toBeNull();
  });

  it('does not request code execution for a documentation-only task', () => {
    const { ctx, ledger } = harness();
    write(ledger, 'docs/usage.md');
    expect(evaluateVerificationReadiness(ctx).status).toBe('not_applicable');
  });

  it.each(['src/prompts/system.md', 'docs/data.json', 'README.mdx', '../REPORT.md'])('does not exempt code or uncertain paths: %s', (path: string) => {
    const { ctx, ledger } = harness();
    validate(ledger);
    write(ledger, path);
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('keeps mixed code/documentation patches subject to validation', () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    ledger.record({ name: 'apply_patch', args: { _raw: '*** Begin Patch\n*** Update File: REPORT.md\n@@\n-old\n+new\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' }, content: 'updated', isError: false, mutates: true, executionClass: 'write' });
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('keeps failures visible after a documentation write', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, true, 'pnpm test > tests.log 2>&1');
    write(ledger, 'REPORT.md');
    expect(evaluateVerificationReadiness(ctx).status).toBe('stale');
  });

  it('reports stale when the post-write validation failed', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, true);
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'stale',
      lastSuccessfulValidationSeq: null,
      lastValidationSeq: 2,
    });
  });

  it('invalidates an earlier success when the latest validation fails', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    validate(ledger, true, 'pnpm run build');
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'stale', lastSuccessfulValidationSeq: 2, lastValidationSeq: 3,
    });
    validate(ledger, false, 'pnpm run build');
    expect(evaluateVerificationReadiness(ctx).status).toBe('fresh');
  });

  it('does not accept echoed test text as verification after a write', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, false, 'echo "npm test"');
    expect(evaluateVerificationReadiness(ctx).status).toBe('missing');
  });

  it('reports fresh when successful validation follows the latest write', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'fresh',
      lastWriteSeq: 1,
      lastSuccessfulValidationSeq: 2,
      validationSignals: ['pnpm test'],
    });
  });

  it('reports fresh for filtered workspace validation and PHP lint', () => {
    const workspace = harness();
    write(workspace.ledger);
    validate(
      workspace.ledger,
      false,
      'pnpm --filter @migrator/core test -- siger.mapper.spec.ts',
    );
    expect(evaluateVerificationReadiness(workspace.ctx)).toMatchObject({
      status: 'fresh',
      validationSignals: ['pnpm test'],
    });

    const php = harness();
    write(php.ledger, 'sync-service/handlers/UserHandler.php');
    validate(php.ledger, false, 'php -l sync-service/handlers/UserHandler.php');
    expect(evaluateVerificationReadiness(php.ctx)).toMatchObject({
      status: 'fresh',
      validationSignals: ['php -l'],
    });
  });

  it('accepts a successful current-run validation for resumed changed files', () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    expect(evaluateVerificationReadiness(ctx)).toMatchObject({
      status: 'fresh',
      source: 'ledger',
      lastWriteSeq: null,
      lastSuccessfulValidationSeq: 1,
    });
  });

  it('ignores writes from earlier runs when suggesting a check', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    ctx.verification.ledgerStartSeq = ledger.lastSeq;
    expect(evaluateVerificationReadiness(ctx).status).toBe('not_applicable');
  });

  it('suggests a check only if verification is relevant to the request', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    expect(renderVerificationReminder(evaluateVerificationReadiness(ctx))).toContain('If verification is relevant to the request');
  });

  it('does not nudge read-only work or a write with fresh validation', () => {
    const readOnly = harness();
    const readOnlyReadiness = evaluateVerificationReadiness(readOnly.ctx);
    expect(renderVerificationReminder(readOnlyReadiness)).toBeNull();

    const verified = harness();
    write(verified.ledger);
    validate(verified.ledger);
    const verifiedReadiness = evaluateVerificationReadiness(verified.ctx);
    expect(renderVerificationReminder(verifiedReadiness)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  buildGoalCompletionAdvisory,
  evaluateVerificationReadinessAtFinish,
  maybeVerificationCompletionRefusal,
  maybeVerificationNudge,
} from '../executing-verification-gate.js';
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
      goal: null,
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

  it('classifies fresh, absent, and weak evidence without blocking', async () => {
    const empty = harness([]);
    expect(buildGoalCompletionAdvisory(
      await evaluateVerificationReadinessAtFinish(empty.ctx),
    )).toMatchObject({ health: 'unverified' });

    const { ctx, ledger } = harness();
    write(ledger);
    expect(buildGoalCompletionAdvisory(
      await evaluateVerificationReadinessAtFinish(ctx),
    )).toMatchObject({ health: 'completed_with_warnings' });

    validate(ledger);
    expect(buildGoalCompletionAdvisory(
      await evaluateVerificationReadinessAtFinish(ctx),
    )).toMatchObject({ health: 'verified' });
  });

  it('nudges exactly once after a write without fresh validation', async () => {
    const { ctx, ledger } = harness();
    write(ledger);
    const readiness = await evaluateVerificationReadinessAtFinish(ctx);

    expect(maybeVerificationNudge(ctx, readiness)).toContain('[verification-required]');
    expect(maybeVerificationNudge(ctx, readiness)).toBeNull();
    expect(maybeVerificationCompletionRefusal(ctx)).toBeNull();
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

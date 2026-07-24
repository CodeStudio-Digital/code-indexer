import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import {
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

function validate(ledger: ToolCallLedger, isError = false) {
  ledger.record({
    name: 'run_command',
    args: { command: 'pnpm test' },
    content: isError ? 'exit code 1' : 'exit code 0',
    isError,
    executionClass: 'execute',
  });
}

describe('evaluateVerificationReadinessAtFinish', () => {
  it('is not applicable when no files or writes exist', () => {
    const { ctx } = harness([]);
    expect(evaluateVerificationReadinessAtFinish(ctx).status).toBe('not_applicable');
  });

  it('reports missing after a write with no validation', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'missing',
      source: 'ledger',
      lastWriteSeq: 1,
    });
  });

  it('reports stale when validation precedes the latest write', () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    write(ledger);
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'stale',
      lastValidationSeq: 1,
      lastWriteSeq: 2,
    });
  });

  it('reports stale when the post-write validation failed', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger, true);
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'stale',
      lastSuccessfulValidationSeq: null,
      lastValidationSeq: 2,
    });
  });

  it('reports fresh when successful validation follows the latest write', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    validate(ledger);
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'fresh',
      lastWriteSeq: 1,
      lastSuccessfulValidationSeq: 2,
      validationSignals: ['pnpm test'],
    });
  });

  it('accepts a successful current-run validation for resumed changed files', () => {
    const { ctx, ledger } = harness();
    validate(ledger);
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'fresh',
      source: 'ledger',
      lastWriteSeq: null,
      lastSuccessfulValidationSeq: 1,
    });
  });

  it('uses persisted evidence on a resumed run with no current-run write', () => {
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
    expect(evaluateVerificationReadinessAtFinish(ctx)).toMatchObject({
      status: 'ambiguous',
      source: 'persisted',
    });
  });

  it('nudges once, then lets the reversible gate yield', () => {
    const { ctx, ledger } = harness();
    write(ledger);
    const readiness = evaluateVerificationReadinessAtFinish(ctx);
    expect(maybeVerificationNudge(ctx, readiness)).toContain('Completion evidence is not fresh');
    expect(maybeVerificationNudge(ctx, readiness)).toBeNull();
  });

  it('refuses an early update_goal, then accepts it after fresh validation', () => {
    const { ctx, ledger } = harness();
    ctx.opts.toolContext.getGoalState = () => ({
      text: 'Implement and verify the change',
      status: 'in_progress',
      budgetTokens: null,
      completionNote: null,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
    });
    write(ledger);

    expect(maybeVerificationCompletionRefusal(ctx))
      .toContain('Refused `update_goal`');
    expect(ctx.verification.nudges).toBe(1);

    validate(ledger);
    expect(maybeVerificationCompletionRefusal(ctx)).toBeNull();
  });

  it('does not mask update_goal missing-goal handling', () => {
    const { ctx, ledger } = harness();
    ctx.opts.toolContext.getGoalState = () => null;
    write(ledger);

    expect(maybeVerificationCompletionRefusal(ctx)).toBeNull();
    expect(ctx.verification.nudges).toBe(0);
  });
});

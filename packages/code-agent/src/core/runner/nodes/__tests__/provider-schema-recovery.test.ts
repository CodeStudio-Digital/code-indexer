import { expect, it } from 'vitest';
import { makeTestContext } from './test-helpers.js';
import { RecoveringNode } from '../recovering.js';
import { rejectedProviderTools, toolSchemaRecoveryPrompt } from '../../provider-schema-recovery.js';

const rejection = (name = 'ext_rea__capture_browser_scenario') => ({
  kind: 'ProviderError' as const, status: 0, retryable: false,
  message: `Invalid schema for function '${name}': null is not of types "boolean", "object"`,
});

it('changes a known failed projection once without spending a transport retry or claiming execution', async () => {
  const { ctx } = makeTestContext();
  ctx.lastProviderToolNames = new Set(['ext_rea__capture_browser_scenario', 'read_file']);
  const node = new RecoveringNode();
  expect((await node.execute(ctx, rejection())).kind).toBe('TurnSucceeded');
  expect([...rejectedProviderTools(ctx)]).toEqual(['ext_rea__capture_browser_scenario']);
  expect(ctx.recovery.size).toBe(0);
  expect(ctx.error).toBeNull();
  expect(toolSchemaRecoveryPrompt(ctx)).toContain('did not execute');
  expect(toolSchemaRecoveryPrompt(ctx)).toContain('same authorization');
  expect((await node.execute(ctx, { ...rejection(), retryable: true })).kind).toBe('Aborted');
  expect(ctx.error?.message).toBe(rejection().message);
  expect(ctx.recovery.size).toBe(0);
});

it('does not remove tools based on an unknown name or a nameless error, even if flagged retryable', async () => {
  for (const event of [rejection('not_in_request'), { ...rejection(), message: 'invalid tool schema', code: 'invalid_tool_schema' }]) {
    const { ctx } = makeTestContext();
    ctx.lastProviderToolNames = new Set(['read_file']);
    expect((await new RecoveringNode().execute(ctx, { ...event, retryable: true })).kind).toBe('Aborted');
    expect(ctx.rejectedToolSchemas.size).toBe(0);
    expect(ctx.recovery.size).toBe(0);
  }
});

it('bounds distinct declaration failures and scopes compatibility to a provider/model within a run', async () => {
  const { ctx } = makeTestContext();
  ctx.lastProviderToolNames = new Set(['t0', 't1', 't2', 't3', 't4']);
  const node = new RecoveringNode();
  for (let i = 0; i < 4; i++) expect((await node.execute(ctx, rejection(`t${i}`))).kind).toBe('TurnSucceeded');
  expect((await node.execute(ctx, rejection('t4'))).kind).toBe('Aborted');
  ctx.opts.provider.setModel('another-model');
  expect(rejectedProviderTools(ctx).size).toBe(0);
  expect(toolSchemaRecoveryPrompt(ctx)).toBe('');
  expect(makeTestContext().ctx.rejectedToolSchemas.size).toBe(0);
});

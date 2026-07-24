/**
 * binding-failover — the runtime failover runner. Pure unit test (no DB):
 * a fake `runOne` drives every branch — first-wins, fail-over-on-error,
 * empty-as-failure, misconfig-skip, thrown-adapter, and empty-chain.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/index.js';
import type { ChatCallResult } from '../llm-chat.js';
import { callChatWithFailover } from '../binding-failover.js';

function b(id: string, kind = 'openai'): ResolvedBinding {
  return {
    pipelineName: 'doc_ingest',
    bindingRole: 'classifier',
    provider: { id, kind, name: id, api_key: 'k' } as ResolvedBinding['provider'],
    modelId: 'm',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 1,
  };
}

const ok = (content = 'ok'): ChatCallResult => ({ content, latencyMs: 1 });
const err = (errorBody = 'boom'): ChatCallResult => ({ content: '', errorBody, latencyMs: 1 });
const NO_RETRY = { retry: { maxRetries: 0 } };

describe('callChatWithFailover', () => {
  it('first binding succeeds → second never called', async () => {
    const calls: string[] = [];
    const res = await callChatWithFailover([b('a'), b('bb')], async (bind) => {
      calls.push(bind.provider.id);
      return ok();
    }, NO_RETRY);
    expect(calls).toEqual(['a']);
    expect(res.binding?.provider.id).toBe('a');
    expect(res.attemptIndex).toBe(0);
    expect(res.failedOver).toBe(false);
  });

  it('first binding errors → second serves (failedOver)', async () => {
    const res = await callChatWithFailover([b('a'), b('bb')], async (bind) =>
      bind.provider.id === 'a' ? err() : ok('served'), NO_RETRY);
    expect(res.binding?.provider.id).toBe('bb');
    expect(res.attemptIndex).toBe(1);
    expect(res.failedOver).toBe(true);
    expect(res.result.content).toBe('served');
  });

  it('all bindings fail → returns the last error result', async () => {
    const res = await callChatWithFailover([b('a'), b('bb')], async () => err('down'), NO_RETRY);
    expect(res.result.errorBody).toBe('down');
    expect(res.attemptIndex).toBe(1);
    expect(res.failedOver).toBe(true);
  });

  it('an empty (errorBody-free) reply counts as failure and fails over', async () => {
    const res = await callChatWithFailover([b('a'), b('bb')], async (bind) =>
      bind.provider.id === 'a' ? ok('   ') : ok('real'), NO_RETRY);
    expect(res.binding?.provider.id).toBe('bb');
    expect(res.failedOver).toBe(true);
  });

  it('treatEmptyAsError:false accepts an empty reply as success (no failover)', async () => {
    const res = await callChatWithFailover([b('a'), b('bb')], async (bind) =>
      bind.provider.id === 'a' ? ok('   ') : ok('real'), { ...NO_RETRY, treatEmptyAsError: false });
    expect(res.binding?.provider.id).toBe('a');
    expect(res.failedOver).toBe(false);
  });

  it('a misconfigured binding (bindingProblem) is skipped without a call', async () => {
    const calls: string[] = [];
    const res = await callChatWithFailover([b('a', 'totally-unsupported'), b('bb')], async (bind) => {
      calls.push(bind.provider.id);
      return ok();
    }, NO_RETRY);
    expect(calls).toEqual(['bb']); // 'a' rejected pre-flight, runOne never ran for it
    expect(res.binding?.provider.id).toBe('bb');
    expect(res.failedOver).toBe(true);
  });

  it('a chat fn that THROWS becomes a failed attempt and fails over', async () => {
    const res = await callChatWithFailover([b('a'), b('bb')], async (bind) => {
      if (bind.provider.id === 'a') throw new Error('network reset');
      return ok('recovered');
    }, NO_RETRY);
    expect(res.binding?.provider.id).toBe('bb');
    expect(res.result.content).toBe('recovered');
    expect(res.failedOver).toBe(true);
  });

  it('retries caller-rejected content once on the same binding', async () => {
    let calls = 0;
    const res = await callChatWithFailover(
      [b('a'), b('bb')],
      async () => ok(++calls === 1 ? '{"findings":[' : '{"findings":[]}'),
      {
        ...NO_RETRY,
        invalidResultRetries: 1,
        validateResult: (result) => result.content.endsWith(']}') ? null : 'invalid JSON',
      },
    );
    expect(calls).toBe(2);
    expect(res.binding?.provider.id).toBe('a');
    expect(res.result.content).toBe('{"findings":[]}');
    expect(res.providerCalls).toBe(2);
  });

  it('fails over after caller-rejected content exhausts its same-binding retry', async () => {
    const calls: string[] = [];
    const res = await callChatWithFailover(
      [b('a'), b('bb')],
      async (bind) => {
        calls.push(bind.provider.id);
        return ok(bind.provider.id === 'a' ? '{"findings":[' : '{"findings":[]}');
      },
      {
        ...NO_RETRY,
        invalidResultRetries: 1,
        validateResult: (result) => result.content.endsWith(']}') ? null : 'invalid JSON',
      },
    );
    expect(calls).toEqual(['a', 'a', 'bb']);
    expect(res.binding?.provider.id).toBe('bb');
    expect(res.failedOver).toBe(true);
    expect(res.providerCalls).toBe(3);
  });

  it('empty chain → synthetic no_binding result, never throws', async () => {
    const res = await callChatWithFailover([], async () => ok());
    expect(res.binding).toBeNull();
    expect(res.attemptIndex).toBe(-1);
    expect(res.result.errorBody).toMatch(/no_binding/);
  });
});

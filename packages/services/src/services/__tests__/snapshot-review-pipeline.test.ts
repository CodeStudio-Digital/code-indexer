import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/index.js';
import type { ChatCallResult } from '../../quality/llm-chat.js';
import type { FileDiff } from '../session-snapshots.js';

const mocks = vi.hoisted(() => ({
  callConfiguredChat: vi.fn(),
}));

vi.mock('../../quality/binding-chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../quality/binding-chat.js')>();
  return { ...actual, callConfiguredChat: mocks.callConfiguredChat };
});

import { SnapshotReviewPipeline } from '../snapshot-review-pipeline.js';

function binding(id: string): ResolvedBinding {
  return {
    pipelineName: 'snapshot_review',
    bindingRole: 'reviewer',
    provider: { id, kind: 'openai', name: id, api_key: 'key' } as ResolvedBinding['provider'],
    modelId: 'review-model',
    modelMode: '',
    config: { max_tokens: 4000 },
    resolvedFrom: 'global',
    bindingId: id === 'primary' ? 1 : 2,
  };
}

function diff(): FileDiff<string> {
  return {
    baseline: {
      id: '00000000-0000-4000-8000-000000000010',
      filePath: 'src/a.ts',
      existedBefore: true,
      oversized: false,
      status: 'active',
    },
    hunks: [
      {
        fingerprint: 'fp1',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        addedCount: 1,
        removedCount: 1,
        hiddenBefore: 0,
        hiddenAfter: 0,
        canExpandBefore: false,
        canExpandAfter: false,
        lines: [
          { type: 'remove', oldLine: 1, content: 'const x = 0;' },
          { type: 'add', newLine: 1, content: 'const x = 1;' },
        ],
        decision: 'pending',
      },
    ],
    diffDisabled: false,
    currentContent: 'const x = 1;',
  };
}

function chat(content: string): ChatCallResult {
  return { content, latencyMs: 1, finishReason: 'provider' };
}

function pipeline(bindings: ResolvedBinding[]): SnapshotReviewPipeline {
  const resolver = {
    resolveChain: vi.fn(async () => bindings),
  };
  return new SnapshotReviewPipeline(resolver as never);
}

function input() {
  const sessionId = '00000000-0000-4000-8000-000000000042';
  return {
    sessionKind: 'coder' as const,
    sessionId,
    resolveContext: { sessionId },
    diffs: [diff()],
  };
}

beforeEach(() => {
  mocks.callConfiguredChat.mockReset();
});

describe('SnapshotReviewPipeline structured response recovery', () => {
  it('forwards caller cancellation and never starts fallback or content repair', async () => {
    const controller = new AbortController();
    mocks.callConfiguredChat.mockImplementation(async (_binding, _messages, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(new Error('review stopped'));
      return chat('{"findings":[');
    });
    const result = await pipeline([binding('primary'), binding('fallback')]).review({ ...input(), signal: controller.signal });
    expect(result).toMatchObject({ ok: false, errorCode: 'review_pipeline_cancelled' });
    expect(mocks.callConfiguredChat).toHaveBeenCalledTimes(1);
  });
  it('does not resolve providers for an already-cancelled review', async () => {
    const controller = new AbortController(); controller.abort();
    const resolveChain = vi.fn();
    const result = await new SnapshotReviewPipeline({ resolveChain } as never).review({ ...input(), signal: controller.signal });
    expect(result.errorCode).toBe('review_pipeline_cancelled');
    expect(resolveChain).not.toHaveBeenCalled();
    expect(mocks.callConfiguredChat).not.toHaveBeenCalled();
  });
  it('retries malformed JSON once on the same binding and uses the valid retry', async () => {
    mocks.callConfiguredChat
      .mockResolvedValueOnce(chat('{"findings":[{"severity":"high"}'))
      .mockResolvedValueOnce(chat('{"findings":[]}'));

    const result = await pipeline([binding('primary')]).review(input());

    expect(result).toMatchObject({
      ok: true,
      findings: [],
      raw: '{"findings":[]}',
      providerId: 'primary',
    });
    expect(mocks.callConfiguredChat).toHaveBeenCalledTimes(2);
    expect(mocks.callConfiguredChat.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 60_000 });
  });

  it('fails over after the primary returns malformed JSON twice', async () => {
    mocks.callConfiguredChat.mockImplementation(async (b: ResolvedBinding) =>
      chat(b.provider.id === 'primary' ? '{"findings":[' : '{"findings":[]}'),
    );

    const result = await pipeline([binding('primary'), binding('fallback')]).review(input());

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('fallback');
    expect(mocks.callConfiguredChat.mock.calls.map((call) => call[0].provider.id))
      .toEqual(['primary', 'primary', 'fallback']);
  });

  it('preserves the final malformed response when retries and failover are exhausted', async () => {
    const partial = '{"findings":[{"severity":"high"}';
    mocks.callConfiguredChat.mockResolvedValue(chat(partial));

    const result = await pipeline([binding('primary')]).review(input());

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('review_pipeline_invalid_response');
    expect(result.error).toMatch(/array element|JSON/i);
    expect(result.raw).toBe(partial);
    expect(mocks.callConfiguredChat).toHaveBeenCalledTimes(2);
  });

  it('treats a JSON object without the required findings array as invalid', async () => {
    mocks.callConfiguredChat.mockResolvedValue(chat('{}'));

    const result = await pipeline([binding('primary')]).review(input());

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('review_pipeline_invalid_response');
    expect(result.error).toContain('findings array');
    expect(result.raw).toBe('{}');
  });

  it('rejects a legacy numeric baseline id instead of reviving the old record contract', async () => {
    mocks.callConfiguredChat.mockResolvedValue(chat(JSON.stringify({
      findings: [{
        severity: 'high',
        filePath: 'src/a.ts',
        baselineId: 10,
        body: 'Legacy numeric id must not cross the filesystem-session boundary.',
      }],
    })));

    const result = await pipeline([binding('primary')]).review(input());

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('review_pipeline_invalid_response');
    expect(result.error).toMatch(/baselineId.*UUID/i);
    expect(mocks.callConfiguredChat).toHaveBeenCalledTimes(2);
  });
});

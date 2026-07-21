import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageBridge } from '../../../../packages/orchestrator-host/src/MessageBridge.js';
import type { DocsResearchResult } from '../../../../packages/docs-agent/src/types.js';
import {
  registerDocsResearchRpcHandlers,
  requestDocsResearchOverBridge,
} from '../docs-research-rpc.js';

function result(markdown = 'ok'): DocsResearchResult {
  return {
    sessionId: 1,
    markdown,
    chunks_cited: [],
    confidence: 'low',
    telemetry: {
      turns: 1,
      searches: 0,
      chunks_read: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      duration_ms: 1,
    },
  };
}

function bridgePair(): { worker: MessageBridge; host: MessageBridge } {
  const { port1, port2 } = new MessageChannel();
  return {
    worker: new MessageBridge({ port: port1 }),
    host: new MessageBridge({ port: port2 }),
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('docs research worker RPC', () => {
  it('never structured-clones the worker AbortSignal into the request payload', async () => {
    const { worker, host } = bridgePair();
    cleanups.push(() => worker.dispose(), () => host.dispose());
    const off = host.handle('docsResearch', async (payload) => {
      const envelope = payload as { input: Record<string, unknown> };
      expect(envelope.input).not.toHaveProperty('signal');
      return result();
    });
    cleanups.push(off);

    const controller = new AbortController();
    await expect(requestDocsResearchOverBridge(worker, {
      query: 'q',
      signal: controller.signal,
    }, 1_000)).resolves.toMatchObject({ markdown: 'ok' });
  });

  it('rehydrates cancellation with a host-local AbortController', async () => {
    const { worker, host } = bridgePair();
    cleanups.push(() => worker.dispose(), () => host.dispose());
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runResearch = vi.fn(async (input: { signal?: AbortSignal }) => {
      receivedSignal = input.signal;
      markStarted();
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) resolve();
        else input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return result('cancelled cleanly');
    });
    const off = registerDocsResearchRpcHandlers(host, () => ({ runResearch } as never));
    cleanups.push(off);

    const controller = new AbortController();
    const pending = requestDocsResearchOverBridge(worker, {
      query: 'q',
      signal: controller.signal,
    }, 1_000);
    await started;
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal).not.toBe(controller.signal);

    controller.abort();
    await expect(pending).resolves.toMatchObject({ markdown: 'cancelled cleanly' });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('sanitizes the flat legacy payload during a rolling restart', async () => {
    const { worker, host } = bridgePair();
    cleanups.push(() => worker.dispose(), () => host.dispose());
    let receivedSignal: AbortSignal | undefined;
    const off = registerDocsResearchRpcHandlers(host, () => ({
      runResearch: async (input: { signal?: AbortSignal }) => {
        receivedSignal = input.signal;
        return result('legacy accepted');
      },
    } as never));
    cleanups.push(off);

    const legacySignal = new AbortController().signal;
    const response = await worker.request<DocsResearchResult>('docsResearch', {
      query: 'legacy',
      triggeredBy: 'coder',
      signal: legacySignal,
    }, { timeoutMs: 1_000 });
    expect(response.markdown).toBe('legacy accepted');
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal).not.toBe(legacySignal);
  });
});

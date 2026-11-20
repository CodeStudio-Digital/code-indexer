import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpSemanticMutationSink } from '../semantic-mutation-sink.js';

const fakeStore = () => ({
  getProfile: () => ({ embedding_target: { kind: 'onnx' } }),
  noteNamespaceMutation: vi.fn(() => ({ id: 1 })),
  settleNamespaceMutationFence: vi.fn(),
  enqueueReindexJob: vi.fn(),
});
const mutation = { namespace: 'memory:project:p7', itemKeys: ['agent_memory:42'], operation: 'upsert' as const };
afterEach(() => { vi.unstubAllGlobals(); });

describe('index semantic mutation sink', () => {
  it('persists and wakes only the targeted namespace without queuing a profile rebuild', () => {
    const store = fakeStore();
    const wake = vi.fn();
    const sink = createMcpSemanticMutationSink(store as never, { wake });

    sink.noteMutation(mutation);

    expect(store.noteNamespaceMutation).toHaveBeenCalledWith(mutation);
    expect(wake).toHaveBeenCalledWith('memory:project:p7');
    expect(store.enqueueReindexJob).not.toHaveBeenCalled();
  });

  it('without a wake, still persists the delta and sends no request', () => {
    const store = fakeStore();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const sink = createMcpSemanticMutationSink(store as never);

    sink.noteMutation(mutation);
    const fence = sink.beginMutation!(mutation)!;
    sink.settleMutation!(fence);

    expect(store.noteNamespaceMutation).toHaveBeenCalledTimes(2);
    expect(store.settleNamespaceMutationFence).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});

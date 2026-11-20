import { describe, expect, it, vi } from 'vitest';
import { createMcpSemanticMutationSink } from '../server-control.js';

describe('MCP semantic mutation sink', () => {
  it('persists and wakes only the targeted namespace without queuing a profile rebuild', () => {
    const store = {
      getProfile: () => ({ embedding_target: { kind: 'onnx' } }),
      noteNamespaceMutation: vi.fn(() => ({ id: 1 })),
      settleNamespaceMutationFence: vi.fn(),
      enqueueReindexJob: vi.fn(),
    };
    const wake = vi.fn();
    const sink = createMcpSemanticMutationSink(store as never, { wake });

    sink.noteMutation({
      namespace: 'memory:project:p7',
      itemKeys: ['agent_memory:42'],
      operation: 'upsert',
    });

    expect(store.noteNamespaceMutation).toHaveBeenCalledWith({
      namespace: 'memory:project:p7',
      itemKeys: ['agent_memory:42'],
      operation: 'upsert',
    });
    expect(wake).toHaveBeenCalledWith('memory:project:p7');
    expect(store.enqueueReindexJob).not.toHaveBeenCalled();
  });
});

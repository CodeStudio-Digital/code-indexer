import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedBinding } from '@mcp/services/pipelines/provider-resolver.js';
import { __resetCompletionCircuitsForTests, noteCircuitFailure, selectCircuitBinding } from '../completion/circuit.js';

const b = (id: number): ResolvedBinding => ({
  pipelineName: 'editor', bindingRole: 'autocomplete', bindingId: id,
  provider: { id: `p${id}`, kind: 'openai', name: `P${id}` } as never,
  modelId: `m${id}`, modelMode: '', config: {}, resolvedFrom: 'global',
});

beforeEach(() => { __resetCompletionCircuitsForTests(); vi.useRealTimers(); });

describe('completion circuits', () => {
  it('moves to the next binding only on the next selection', () => {
    const chain = [b(1), b(2)];
    expect(selectCircuitBinding(chain, 7)?.binding.bindingId).toBe(1);
    noteCircuitFailure(chain[0]!, 7, { finishReason: 'timeout', errorBody: 'timeout' }, 4000);
    expect(selectCircuitBinding(chain, 7)?.binding.bindingId).toBe(2);
  });

  it('keeps auth blocked until configuration changes and honors Retry-After', () => {
    vi.useFakeTimers();
    const auth = b(1);
    noteCircuitFailure(auth, 7, { status: 401 }, 4000);
    expect(selectCircuitBinding([auth], 7)).toBeNull();
    expect(selectCircuitBinding([{ ...auth, config: { revision: 2 } }], 7)).not.toBeNull();
    const rate = b(2);
    noteCircuitFailure(rate, 7, { status: 429, retryAfterMs: 2000 }, 4000);
    expect(selectCircuitBinding([rate], 7)).toBeNull();
    vi.advanceTimersByTime(2001);
    vi.setSystemTime(Date.now() + 2001);
    expect(selectCircuitBinding([rate], 7)).not.toBeNull();
  });
});

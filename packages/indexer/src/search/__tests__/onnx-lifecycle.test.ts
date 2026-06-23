/**
 * ONNX idle lifecycle for LocalEmbeddingService and LocalReranker:
 * single lazy creation, idle eviction calls dispose (which releases the
 * native session in the real lib), transparent re-creation afterwards.
 * `vi.mock` intercepts the services' dynamic import of transformers.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface MockCounters { created: number; disposed: number }

vi.mock('@huggingface/transformers', () => {
  const counters: MockCounters = { created: 0, disposed: 0 };

  const pipeline = async (_task: string, _model: string) => {
    counters.created++;
    const extractor = async (texts: string[]) => ({
      tolist: () => texts.map((_, i) => [0.1 + i, 0.2, 0.3]),
    });
    (extractor as unknown as { dispose: () => Promise<void> }).dispose = async () => {
      counters.disposed++;
    };
    return extractor;
  };

  const AutoTokenizer = {
    from_pretrained: async () => (texts: string[], _opts: unknown) => ({ input_ids: texts }),
  };
  const AutoModelForSequenceClassification = {
    from_pretrained: async () => {
      counters.created++;
      const model = async (inputs: { input_ids: string[] }) => ({
        logits: { tolist: () => inputs.input_ids.map((_, i) => [i === 0 ? 2 : -1]) },
      });
      (model as unknown as { dispose: () => Promise<void> }).dispose = async () => {
        counters.disposed++;
      };
      return model;
    },
  };

  return { pipeline, AutoTokenizer, AutoModelForSequenceClassification, env: {}, __counters: counters };
});

async function counters(): Promise<MockCounters> {
  const mod = (await import('@huggingface/transformers')) as unknown as { __counters: MockCounters };
  return mod.__counters;
}

beforeEach(async () => {
  vi.useFakeTimers();
  const c = await counters();
  c.created = 0;
  c.disposed = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('LocalEmbeddingService lifecycle', () => {
  it('creates once, evicts after idle TTL, re-creates on next embed', async () => {
    const { LocalEmbeddingService } = await import('../local-embeddings.js');
    const svc = new LocalEmbeddingService({ idleTtlMs: 1000 });
    const c = await counters();

    const r1 = await svc.embed(['a', 'b']);
    expect(r1.vectors).toHaveLength(2);
    await svc.embedQuery('q');
    expect(c.created).toBe(1); // shared session across calls

    await vi.advanceTimersByTimeAsync(1100);
    expect(c.disposed).toBe(1); // idle eviction released the session

    const r2 = await svc.embed(['c']);
    expect(r2.vectors).toHaveLength(1);
    expect(c.created).toBe(2); // transparent re-creation

    await svc.dispose();
    await svc.dispose(); // idempotent
    expect(c.disposed).toBe(2);
  });

  it('idleTtlMs 0 never evicts', async () => {
    const { LocalEmbeddingService } = await import('../local-embeddings.js');
    const svc = new LocalEmbeddingService({ idleTtlMs: 0 });
    const c = await counters();
    await svc.embed(['a']);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(c.disposed).toBe(0);
    await svc.dispose();
    expect(c.disposed).toBe(1);
  });
});

describe('LocalReranker lifecycle', () => {
  it('scores, evicts after idle TTL, and re-creates on next rerank', async () => {
    const { LocalReranker } = await import('../local-reranker.js');
    const rr = new LocalReranker({ idleTtlMs: 1000 });
    const c = await counters();

    const results = await rr.rerank('query', [
      { id: 'x', text: 'first', originalScore: 0.5 },
      { id: 'y', text: 'second', originalScore: 0.4 },
    ], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('x'); // logit 2 > logit -1 after sigmoid
    expect(c.created).toBe(1);

    await vi.advanceTimersByTimeAsync(1100);
    expect(c.disposed).toBe(1);

    const again = await rr.rerank('query', [{ id: 'z', text: 't', originalScore: 0.1 }], 1);
    expect(again).toHaveLength(1);
    expect(c.created).toBe(2);

    await rr.dispose();
    expect(c.disposed).toBe(2);
  });
});

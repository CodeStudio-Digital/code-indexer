/**
 * W2/P3 — fila bounded do restore da árvore. Testa cap de concorrência, dedup,
 * prioridade e clear(). Puro, sem React/timers reais além de microtasks.
 */
import { describe, it, expect } from 'vitest';
import { createBoundedQueue } from '../file-tree-loader.js';

function deferred(): { p: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const p = new Promise<void>((r) => { resolve = r; });
  return { p, resolve };
}

describe('createBoundedQueue', () => {
  it('nunca passa de N in-flight', async () => {
    const q = createBoundedQueue(2);
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 5 }, deferred);
    gates.forEach((g, i) =>
      q.push(`k${i}`, i, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await g.p;
        active--;
      }),
    );
    expect(maxActive).toBeLessThanOrEqual(2); // só 2 arrancaram
    for (const g of gates) g.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(maxActive).toBeLessThanOrEqual(2); // nunca estourou o cap
  });

  it('dedup por key', () => {
    const q = createBoundedQueue(1);
    let runs = 0;
    const g = deferred();
    q.push('same', 0, async () => { runs++; await g.p; });
    q.push('same', 0, async () => { runs++; }); // ignorado (key já enfileirada/rodando)
    expect(runs).toBe(1);
  });

  it('respeita prioridade (menor primeiro)', async () => {
    const q = createBoundedQueue(1);
    const order: number[] = [];
    const g = deferred();
    q.push('block', 0, async () => { await g.p; }); // ocupa o único slot
    q.push('hi', 5, async () => { order.push(5); });
    q.push('lo', 1, async () => { order.push(1); });
    g.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 5]); // 1 antes de 5
  });

  it('clear() descarta pendentes e permite re-push', async () => {
    const q = createBoundedQueue(1);
    let ran = 0;
    const g = deferred();
    q.push('block', 0, async () => { await g.p; }); // ocupa o slot
    q.push('pend', 1, async () => { ran++; }); // pendente
    q.clear(); // descarta 'pend'
    g.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(0);
    // re-push após clear funciona (key liberada do dedup)
    let ran2 = 0;
    q.push('pend', 0, async () => { ran2++; });
    await new Promise((r) => setTimeout(r, 0));
    expect(ran2).toBe(1);
  });
});

/**
 * Fila bounded para o restore da árvore de arquivos (W2/P3).
 *
 * O `init` antigo disparava `ensureLoaded()` em PARALELO para CADA dir persistido-
 * expandido (até 500) — um thundering herd de `files.tree` que travava a abertura do
 * projeto. Esta fila limita a concorrência e ordena por prioridade (dirs rasos/visíveis
 * primeiro), então a árvore "parece" restaurada em ~100ms mesmo com dirs profundos
 * pingando. Sem React, testável puro.
 */
interface BoundedQueue {
  /** Enfileira um job; dedup por key. Menor `priority` roda primeiro. */
  push(key: string, priority: number, run: () => Promise<void>): void;
  /** Cancela os pendentes (os in-flight rodam até o fim). */
  clear(): void;
  readonly pending: number;
}

interface Job {
  key: string;
  priority: number;
  run: () => Promise<void>;
}

export function createBoundedQueue(concurrency: number): BoundedQueue {
  const queued = new Set<string>(); // dedup de enfileirados + em execução
  let heap: Job[] = []; // array ordenado por priority asc (insert ordenado; ≤500 itens, raro)
  let active = 0;

  const pump = (): void => {
    while (active < concurrency && heap.length > 0) {
      const job = heap.shift()!;
      active++;
      job
        .run()
        .catch(() => undefined)
        .finally(() => {
          active--;
          queued.delete(job.key);
          pump();
        });
    }
  };

  return {
    get pending() {
      return heap.length + active;
    },
    push(key, priority, run) {
      if (queued.has(key)) return; // dedup
      queued.add(key);
      const at = heap.findIndex((j) => j.priority > priority);
      const job: Job = { key, priority, run };
      if (at < 0) heap.push(job);
      else heap.splice(at, 0, job);
      pump();
    },
    clear() {
      // Descarta só os pendentes (que vivem no heap); tira suas keys do dedup para
      // poderem ser re-enfileiradas. Os in-flight não estão no heap → suas keys
      // permanecem em `queued` e saem no próprio `finally`.
      for (const j of heap) queued.delete(j.key);
      heap = [];
    },
  };
}

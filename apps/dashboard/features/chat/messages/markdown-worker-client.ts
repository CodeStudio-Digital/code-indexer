import type { MarkdownDocument } from './markdown-document.js';

type Result = { document?: MarkdownDocument; error?: string; source?: string };
type Request = { id: number; text: string; receive: (result: Result) => void };
export interface MarkdownWorkerPort {
  postMessage(value: { id: number; text: string }): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<Result & { id: number }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** One parser per renderer, one in-flight job, newest queued text per owner.
 * Disposal drops callbacks/source immediately. No polling or idle worker. */
export class MarkdownWorkerQueue {
  private worker: MarkdownWorkerPort | null = null;
  private owners = new Set<symbol>();
  private pending = new Map<symbol, Request>();
  private active: { owner: symbol; request: Request } | null = null;
  private sequence = 0;
  constructor(private createWorker: () => MarkdownWorkerPort) {}

  acquire(receive: (result: Result) => void) {
    const owner = Symbol('markdown');
    this.owners.add(owner);
    return {
      update: (text: string) => {
        if (!this.owners.has(owner)) return;
        this.pending.set(owner, { id: ++this.sequence, text, receive });
        this.pump();
      },
      dispose: () => {
        this.owners.delete(owner);
        this.pending.delete(owner);
        if (this.active?.owner === owner) {
          // The worker owns its structured clone already; release renderer data.
          this.active.request = { ...this.active.request, text: '', receive: () => {} };
        }
        if (!this.owners.size) this.close();
      },
    };
  }

  private close() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = null;
    this.active = null;
    this.pending.clear();
  }

  private pump() {
    if (this.active || !this.pending.size) return;
    const [owner, request] = this.pending.entries().next().value!;
    this.pending.delete(owner);
    this.active = { owner, request };
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = event => {
          const completed = this.active;
          if (!completed || completed.request.id !== event.data.id) return;
          this.active = null;
          const newest = this.pending.get(completed.owner)?.text;
          // An appended stream may reuse a parsed prefix. Replaced/edited text
          // must never publish a document from the previous answer.
          if (this.owners.has(completed.owner) && (newest === undefined || newest.startsWith(completed.request.text))) {
            completed.request.receive({ ...event.data, source: completed.request.text });
          }
          this.pump();
        };
        this.worker.onerror = event => {
          const callbacks = [this.active?.request, ...this.pending.values()];
          this.close();
          for (const callback of callbacks) callback?.receive({ error: event.message });
        };
      }
      this.worker.postMessage({ id: request.id, text: request.text });
    } catch (error) {
      this.active = null;
      request.receive({ error: String(error) });
      this.pump();
    }
  }
}

export const markdownWorkerQueue = new MarkdownWorkerQueue(() =>
  new Worker(new URL('./markdown-parser.worker.ts', import.meta.url), { type: 'module' }));

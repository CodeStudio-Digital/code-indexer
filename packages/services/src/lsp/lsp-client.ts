/**
 * JSON-RPC 2.0 client over a child process's stdio with LSP framing.
 *
 * Beyond request/notify, real servers REQUIRE the client side of the
 * protocol to answer THEIR requests — pyright stalls without a
 * `workspace/configuration` response, and most servers send
 * `client/registerCapability` + `window/workDoneProgress/create` during
 * startup. Unknown server→client requests get an empty success result
 * (never an error — some servers treat that as fatal).
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { encodeMessage, FrameParser } from './jsonrpc-framing.js';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LspRpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  private parser: FrameParser;
  private disposed = false;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private log: (msg: string) => void = () => {},
  ) {
    this.parser = new FrameParser((err) => this.log(`frame error: ${err.message}`));
    child.stdout.on('data', (chunk: Buffer) => {
      for (const msg of this.parser.push(chunk)) this.dispatch(msg as Record<string, unknown>);
    });
    // Defaults every mainstream server expects to "just work".
    this.onRequest('workspace/configuration', (params) => {
      const items = (params as { items?: unknown[] })?.items ?? [];
      return items.map(() => null); // null = "use your defaults"
    });
    this.onRequest('client/registerCapability', () => null);
    this.onRequest('client/unregisterCapability', () => null);
    this.onRequest('window/workDoneProgress/create', () => null);
    this.onRequest('workspace/workspaceFolders', () => null);
    this.onRequest('window/showMessageRequest', () => null);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('lsp client disposed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  onNotification(method: string, fn: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) { set = new Set(); this.notificationHandlers.set(method, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Server→client request handler (last registration wins). */
  onRequest(method: string, fn: (params: unknown) => unknown | Promise<unknown>): void {
    this.requestHandlers.set(method, fn);
  }

  /** Reject all pending requests; safe to call repeatedly. */
  dispose(reason = 'lsp client disposed'): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  private send(message: unknown): void {
    try {
      this.child.stdin.write(encodeMessage(message));
    } catch (err) {
      this.log(`stdin write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response to one of OUR requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(new Error(`LSP error ${e.code ?? ''}: ${e.message ?? 'unknown'}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // Server→client REQUEST (has both id and method) — must be answered.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      const handler = this.requestHandlers.get(msg.method);
      void Promise.resolve()
        .then(() => (handler ? handler(msg.params) : null))
        .then(
          (result) => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }),
          (err) => {
            this.log(`server request ${msg.method} handler failed: ${err}`);
            this.send({ jsonrpc: '2.0', id: msg.id, result: null });
          },
        );
      return;
    }

    // Notification.
    if (typeof msg.method === 'string') {
      const set = this.notificationHandlers.get(msg.method);
      if (!set) return;
      for (const fn of set) {
        try { fn(msg.params); } catch (err) { this.log(`notification handler ${msg.method} threw: ${err}`); }
      }
    }
  }
}

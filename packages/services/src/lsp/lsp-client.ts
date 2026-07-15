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
  signal?: AbortSignal;
  onAbort?: () => void;
};

const MAX_MESSAGES_PER_TICK = 32;
const MAX_BYTES_PER_TICK = 64 * 1024;

export class LspRpcClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  private parser: FrameParser;
  private disposed = false;
  private draining = false;
  private readonly onStdoutData = (chunk: Buffer): void => {
    if (this.disposed) return;
    this.parser.append(chunk);
    this.pauseStdout();
    this.scheduleDrain();
  };
  private drainScheduled = false;
  private drainCancelled = false;
  private pausedForBackpressure = false;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private log: (msg: string) => void = () => {},
    /**
     * Resolve a config per-projeto para cada `section` pedida em
     * `workspace/configuration` (ex.: `intelephense.environment.phpVersion`,
     * `python.analysis.pythonVersion`). `null`/ausente = "use your defaults"
     * (comportamento original). Ver `lsp-config-map.ts`.
     */
    private resolveConfig?: (section: string | null) => unknown,
    /**
     * LSP servers can return edits while executing a command by calling back
     * into `workspace/applyEdit`. The owner decides whether it can retain and
     * later apply that edit; returning false makes the refusal explicit to the
     * server instead of silently answering `null`.
     */
    private applyWorkspaceEdit?: (edit: unknown) => boolean | Promise<boolean>,
  ) {
    this.parser = new FrameParser((err) => this.log(`frame error: ${err.message}`));
    child.stdout.on('data', this.onStdoutData);
    this.onRequest('workspace/configuration', (params) => {
      const items = (params as { items?: Array<{ section?: string }> })?.items ?? [];
      return items.map((it) => this.resolveConfig?.(it?.section ?? null) ?? null);
    });
    this.onRequest('client/registerCapability', () => null);
    this.onRequest('client/unregisterCapability', () => null);
    this.onRequest('window/workDoneProgress/create', () => null);
    this.onRequest('workspace/workspaceFolders', () => null);
    this.onRequest('window/showMessageRequest', () => null);
    this.onRequest('workspace/applyEdit', async (params) => {
      const edit = (params as { edit?: unknown } | null)?.edit;
      if (!edit || !this.applyWorkspaceEdit) {
        return { applied: false, failureReason: 'Client cannot apply this workspace edit.' };
      }
      try {
        const applied = await this.applyWorkspaceEdit(edit);
        return applied
          ? { applied: true }
          : { applied: false, failureReason: 'Client rejected this workspace edit.' };
      } catch (err) {
        return {
          applied: false,
          failureReason: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('lsp client disposed'));
    if (signal?.aborted) return Promise.reject(this.abortError(method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
        this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = signal ? () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        signal.removeEventListener('abort', onAbort!);
        this.send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
        reject(this.abortError(method));
      } : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, signal, onAbort });
      if (onAbort) signal!.addEventListener('abort', onAbort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params });
      if (signal?.aborted) onAbort?.();
    });
  }

  private abortError(method: string): Error {
    const error = new Error(`LSP request ${method} cancelled`);
    error.name = 'AbortError';
    return error;
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
    this.drainCancelled = true;
    this.child.stdout.off('data', this.onStdoutData);
    this.resumeStdout();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  private pauseStdout(): void {
    if (this.pausedForBackpressure) return;
    this.child.stdout.pause();
    this.pausedForBackpressure = true;
  }

  private resumeStdout(): void {
    if (!this.pausedForBackpressure) return;
    this.child.stdout.resume();
    this.pausedForBackpressure = false;
  }

  private scheduleDrain(): void {
    if (this.disposed || this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drainBufferedMessages();
    });
  }

  private drainBufferedMessages(): void {
    if (this.disposed || this.drainCancelled) return;
    this.draining = true;
    try {
      const messages = this.parser.drain(MAX_MESSAGES_PER_TICK, MAX_BYTES_PER_TICK);
      for (const msg of messages) this.dispatch(msg as Record<string, unknown>);
    } finally {
      this.draining = false;
    }
    if (this.disposed || this.drainCancelled) return;
    if (this.parser.hasCompleteMessage()) {
      this.pauseStdout();
      this.scheduleDrain();
      return;
    }
    // The parser needs more bytes. Resume the pipe; a buffered chunk may emit
    // immediately and pause/schedule itself again through onStdoutData.
    this.resumeStdout();
  }

  private send(message: unknown): void {
    try {
      this.child.stdin.write(encodeMessage(message));
    } catch (err) {
      this.log(`stdin write failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(new Error(`LSP error ${e.code ?? ''}: ${e.message ?? 'unknown'}`));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

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

    if (typeof msg.method === 'string') {
      const set = this.notificationHandlers.get(msg.method);
      if (!set) return;
      for (const fn of set) {
        try { fn(msg.params); } catch (err) { this.log(`notification handler ${msg.method} threw: ${err}`); }
      }
    }
  }
}

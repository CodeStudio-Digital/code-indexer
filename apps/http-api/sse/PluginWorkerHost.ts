/**
 * Main-thread host for the plugin worker. Lazily spawns one worker_thread
 * (reusing the dev-tsx bootstrap via resolveWorkerFile), loads the enabled
 * plugins' built bundles, and exposes `invokeTool` with request/response
 * correlation + a reverse `host.invoke` channel.
 *
 * Standalone (not the CoderWorkerPool) — plugin handlers are short, isolated
 * calls; one shared worker per host instance is plenty.
 */
import { Worker } from 'node:worker_threads';
import { resolveWorkerFile } from './workerFileResolution.js';

export interface PluginBundleRef {
  namespace: string;
  file: string;
}

export type HostInvoke = (
  method: string,
  payload: unknown,
  namespace: string,
  cwd: string,
) => Promise<unknown>;

export interface PluginWorkerHostOpts {
  bundles: PluginBundleRef[];
  /** Whitelisted, read-only host surface a plugin handler may call. */
  hostInvoke?: HostInvoke;
}

/** Per-invocation project context (handed to the handler's ctx in the worker). */
export interface InvokeContext {
  projectName: string | null;
  cwd: string;
}

interface ToolResult {
  content: string;
  isError?: boolean;
  /** Structured payload for the plugin's own webview (agent never sees it). */
  data?: unknown;
}

export class PluginWorkerHost {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: ToolResult) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly opts: PluginWorkerHostOpts) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const resolved = resolveWorkerFile(import.meta.url, 'plugin-worker');
    if (!resolved) {
      throw new Error(
        'plugin-worker.{js,ts} not found — run `npm run build` (prod) or `npm run dev:server` (tsx).',
      );
    }
    const w = new Worker(resolved.file, {
      execArgv: resolved.execArgv,
      workerData: {
        tsEntry: resolved.devTsEntry,
        bundles: this.opts.bundles,
      },
    });
    w.on('message', (m: Record<string, unknown>) => this.onMessage(m));
    w.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
    w.on('exit', () => {
      this.failAll(new Error('plugin worker exited'));
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  invokeTool(
    namespace: string,
    name: string,
    args: Record<string, unknown>,
    ctx: InvokeContext,
  ): Promise<ToolResult> {
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({
        kind: 'invoke',
        id,
        namespace,
        name,
        args,
        projectName: ctx.projectName,
        cwd: ctx.cwd,
      });
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    if (m.kind === 'result') {
      const { id, content, isError, data } = m as {
        id: number;
        content: string;
        isError?: boolean;
        data?: unknown;
      };
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.resolve({ content, isError, data });
      }
    } else if (m.kind === 'host') {
      void this.handleHost(
        m as { id: number; method: string; payload?: unknown; namespace: string; cwd: string },
      );
    } else if (m.kind === 'error') {
      this.failAll(new Error(String((m as { message?: string }).message ?? 'plugin worker error')));
    }
  }

  private async handleHost(m: {
    id: number;
    method: string;
    payload?: unknown;
    namespace: string;
    cwd: string;
  }): Promise<void> {
    const w = this.worker;
    if (!w) return;
    try {
      const value = this.opts.hostInvoke
        ? await this.opts.hostInvoke(m.method, m.payload, m.namespace, m.cwd)
        : null;
      w.postMessage({ kind: 'hostResult', id: m.id, ok: true, value });
    } catch (e) {
      w.postMessage({
        kind: 'hostResult',
        id: m.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}

import { NativeLspProcess, type NativeLspProcessOptions } from './native-lsp-process.js';
import type { AgentLspPort, AgentLspQuery, AgentLspAnswer } from '../../../packages/code-agent/src/ports/lsp-port.js';
import { lspPage } from '../../../packages/code-agent/src/ports/lsp-port.js';
import { getGlobalAgentLspBackend } from '../../../packages/code-agent/src/lsp/agent-lsp-backend.js';

/** A warm TS process belongs to one attempt. A cancelled or failed computation
 * is physically terminated before settlement, without synchronous fallback. */
export class NativeLspPort implements AgentLspPort {
  private worker?: NativeLspProcess;
  private closing?: Promise<void>;
  private cleanupFailure?: unknown;
  private closed = false;
  private busy = false;
  private readonly ctrl = new AbortController();
  private sequence = 0;
  private pending = new Set<Promise<AgentLspAnswer>>();
  constructor(private readonly ownerSignal: AbortSignal, private readonly assertOwner: () => void,
    private readonly processOptions: NativeLspProcessOptions) {}

  query(input: AgentLspQuery, signal?: AbortSignal): Promise<AgentLspAnswer> {
    this.assertCurrent(); signal?.throwIfAborted();
    if (this.busy) throw new Error('Agent LSP already has an active computation');
    this.busy = true;
    const bounded = AbortSignal.any([this.ownerSignal, this.ctrl.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    const pending = this.compute(input, bounded).finally(() => { this.busy = false; this.pending.delete(pending); });
    this.pending.add(pending); return pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ctrl.abort(new Error('Agent LSP owner closed'));
    await this.stopWorker();
    await Promise.allSettled([...this.pending]);
  }

  private assertCurrent(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed) throw new Error('Agent LSP owner closed');
    this.ownerSignal.throwIfAborted(); this.assertOwner();
  }

  private async compute(input: AgentLspQuery, signal: AbortSignal): Promise<AgentLspAnswer> {
    signal.throwIfAborted();
    if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(input.file)) {
      if (input.op === 'diagnostics') throw new Error('Use get_diagnostics for non-TypeScript files');
      const backend = getGlobalAgentLspBackend(); if (!backend) throw new Error('Multi-language LSP backend is unavailable');
      const value = await backend[input.op]({ root: input.root, projectName: input.projectName, file: input.file,
        position: { line: input.line!, column: input.column! } }, signal);
      this.assertCurrent(); signal.throwIfAborted();
      if (input.op === 'hover') return { kind: 'hover', hover: value && 'contents' in value
        ? { displayString: value.contents, documentation: '', kind: 'language server / structural index' } : null };
      return { kind: 'locations', ...lspPage(Array.isArray(value) ? value.map(item => ({ file: item.file,
        line: item.range.start.line, column: item.range.start.column })) : [], input) };
    }
    if (this.closing) await this.closing;
    this.assertCurrent(); signal.throwIfAborted();
    if (!this.worker) {
      this.worker = new NativeLspProcess(input.root, this.processOptions);
      // An idle worker can fail between queries. Keep the error observed; its
      // replacement is created lazily and never falls back onto the caller.
      const worker = this.worker;
      worker.on('error', () => {});
      worker.once('exit', () => { if (this.worker === worker && worker.reaped) this.worker = undefined; });
    }
    const worker = this.worker, id = ++this.sequence;
    try {
      const answer = await new Promise<AgentLspAnswer>((resolve, reject) => {
        const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); signal.removeEventListener('abort', onAbort); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = (code: number) => onError(new Error('Agent LSP worker exited before its result (' + code + ')'));
        const onAbort = () => onError(signal.reason ?? new Error('Agent LSP cancelled'));
        const onMessage = (message: { id: number; encoded?: string; error?: string }) => {
          if (message.id !== id) return;
          cleanup();
          try { if (message.error) throw new Error(message.error); resolve(JSON.parse(message.encoded!)); } catch (cause) { reject(cause); }
        };
        worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
        signal.addEventListener('abort', onAbort, { once: true });
        try { this.assertCurrent(); signal.throwIfAborted(); worker.postMessage({ id, input }); } catch (cause) { cleanup(); reject(cause); }
      });
      this.assertCurrent(); signal.throwIfAborted(); return answer;
    } catch (cause) { await this.stopWorker(); throw cause; }
  }

  private stopWorker(): Promise<void> {
    if (this.closing) return this.closing;
    const worker = this.worker;
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (!worker) return Promise.resolve();
    const closing = worker.terminate().then(() => { if (this.worker === worker) this.worker = undefined; })
      .catch(cause => { this.cleanupFailure = cause; throw cause; })
      .finally(() => { if (this.closing === closing) this.closing = undefined; });
    this.closing = closing; return closing;
  }
}

import { readFile, realpath } from 'node:fs/promises';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import type { IPreviewDevtools, PreviewInvoke } from '@mcp/code-agent/tools/preview/index.js';
import type { NativeCoderDevelopmentConfig } from './workers/native-coder-execution.js';
import type { NativeWorkspaceLease } from './native-workspace-leases.js';
import { NativePreviewServers } from './native-preview-server.js';

/** Main-process ownership survives worker RPC cancellation and pipe loss.
 * A worker cannot release its workspace before this close acknowledges reap. */
export class NativePreviewAttempt {
  private readonly owner = {};
  private readonly controller = new AbortController();
  private readonly servers: Promise<NativePreviewServers>;
  private readonly timer: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private readonly onAbort = () => { void this.close().catch(() => undefined); };

  constructor(private readonly backend: IPreviewDevtools, readonly key: string,
    config: NativeCoderDevelopmentConfig, lease: NativeWorkspaceLease, projectId: number | null,
    private readonly ownerSignal: AbortSignal, assertLifetime: () => void, projectRoot?: string | null) {
    if (!backend.authorityAttested || !backend.cancel || !backend.closeOwnedScope) throw new Error('Preview backend lacks native dispatch authority');
    this.servers = (async () => {
      const runtime = await verifyRuntimePackage(config.packageDirectory, parseRuntimePackageAnchor(await readFile(config.anchorPath)));
      const binding = loadNativeHostBridge(runtime);
      if (!binding.startNativeHostDuplexProcess || binding.nativeHostBridgeAbi().duplexOutputVersion !== 1) {
        throw new Error('Preview requires a native contained server bridge');
      }
      // A base-checkout runner is not the preview of a different worktree.
      const sameRoot = projectRoot && (await realpath(projectRoot)).toLowerCase() === (await realpath(lease.root)).toLowerCase();
      return new NativePreviewServers(binding.startNativeHostDuplexProcess, lease.root, projectId,
        lease.expiresAtUnixMs, this.controller.signal, sameRoot ? backend.existingRunners?.() : null);
    })();
    void this.servers.catch(() => undefined);
    this.timer = setInterval(() => {
      try { assertLifetime(); } catch { this.onAbort(); }
    }, 100);
    this.timer.unref();
    ownerSignal.addEventListener('abort', this.onAbort, { once: true });
    if (ownerSignal.aborted) this.onAbort();
  }

  async invoke(request: PreviewInvoke, assertDispatch: () => void, signal: AbortSignal): Promise<unknown> {
    this.controller.signal.throwIfAborted();
    const servers = await this.servers;
    this.controller.signal.throwIfAborted(); signal.throwIfAborted(); assertDispatch();
    return this.backend.invoke(request, { assertDispatch, owner: this.owner,
      signal: AbortSignal.any([this.controller.signal, signal]), runner: servers.forInvocation(assertDispatch) });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.ownerSignal.removeEventListener('abort', this.onAbort);
    this.controller.abort(new Error('Native preview attempt closed'));
    this.closing = this.drain();
    return this.closing;
  }

  private async drain(): Promise<void> {
    const results = await Promise.allSettled([
      this.backend.closeOwnedScope!(this.key, this.owner),
      this.servers.then(servers => servers.close()),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw new Error('Native preview cleanup is unconfirmed', { cause: failure.reason });
  }
}

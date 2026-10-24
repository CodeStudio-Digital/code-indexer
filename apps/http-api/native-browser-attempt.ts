import type { IResearchBrowser, ResearchBrowserInvoke } from '@mcp/shared/research-browser.js';

/** Only anonymous contexts are owned here; the user's Chrome process is borrowed. */
export class NativeBrowserAttempt {
  private readonly owner = {};
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private readonly onAbort = () => { void this.close().catch(() => undefined); };

  constructor(private readonly backend: IResearchBrowser, readonly key: string,
    private readonly signal: AbortSignal, private readonly assertLifetime: () => void) {
    if (!backend.authorityAttested || !backend.cancel || !backend.closeOwnedScope) {
      throw new Error('Research browser lacks native ownership and dispatch authority');
    }
    this.timer = setInterval(() => { try { assertLifetime(); } catch { this.onAbort(); } }, 100);
    this.timer.unref();
    signal.addEventListener('abort', this.onAbort, { once: true });
    if (signal.aborted) this.onAbort();
  }
  async invoke(request: ResearchBrowserInvoke, assertDispatch: () => void, signal: AbortSignal): Promise<unknown> {
    this.controller.signal.throwIfAborted(); signal.throwIfAborted(); assertDispatch();
    return this.backend.invoke(request, { owner: this.owner, assertDispatch, assertLifetime: this.assertLifetime,
      signal: AbortSignal.any([signal, this.controller.signal]) });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer); this.signal.removeEventListener('abort', this.onAbort);
    this.controller.abort(new Error('Native research browser attempt closed'));
    this.closing = this.backend.closeOwnedScope!(this.key, this.owner);
    return this.closing;
  }
}

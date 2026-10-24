import { readPublicWeb, type PublicWebRequest, type PublicWebResponse } from '@mcp/shared/utils/public-web-request.js';
import type { WebPort } from '@mcp/code-agent/ports/web-port.js';
import type { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

export class NativeWebPort implements WebPort {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<PublicWebResponse>>();
  private closing?: Promise<void>;
  constructor(private readonly options: { signal: AbortSignal; effects: HostEffectScope; assertOwner(): void }) {}
  assertCurrent(): void {
    this.controller.signal.throwIfAborted(); this.options.signal.throwIfAborted(); this.options.assertOwner();
  }
  read(input: PublicWebRequest): Promise<PublicWebResponse> {
    if (this.closing || this.pending.size >= 8) return Promise.reject(new Error('Web attempt is closed or saturated'));
    const signal = AbortSignal.any([this.options.signal, this.controller.signal, ...(input.signal ? [input.signal] : [])]);
    const request = this.options.effects.track(() => readPublicWeb({ ...input, signal,
      assertCurrent: () => { this.assertCurrent(); input.assertCurrent?.(); } }));
    this.pending.add(request); void request.finally(() => this.pending.delete(request)).catch(() => undefined);
    return request;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(new Error('Native web attempt closed'));
    return this.closing = Promise.allSettled([...this.pending]).then(() => undefined);
  }
}

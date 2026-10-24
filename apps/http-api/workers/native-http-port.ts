import { sendHttp, type CookieJar, type SendOptions, type RawResponse } from '@mcp/shared/utils/http-engine.js';
import type { HttpPort } from '@mcp/code-agent/ports/http-port.js';
import type { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

interface Options {
  signal: AbortSignal;
  jar: CookieJar;
  effects: HostEffectScope;
  assertOwner(): void;
  outcomeUnknown(): void;
}

/** Physical connections are attempt-owned; cookies retain the existing session
 * lifetime in the worker. No UI socket pool or cookie jar is borrowed. */
export class NativeHttpPort implements HttpPort {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<RawResponse>>();
  private closing?: Promise<void>;
  constructor(private readonly options: Options) {}
  outcomeUnknown(): void { this.options.outcomeUnknown(); }
  send(input: Omit<SendOptions, 'jar'> & { resetCookies?: boolean }): Promise<RawResponse> {
    if (this.closing || this.pending.size >= 32) return Promise.reject(new Error('HTTP attempt is closed or saturated'));
    const signal = AbortSignal.any([this.options.signal, this.controller.signal, ...(input.signal ? [input.signal] : [])]);
    const assertDispatch = () => { signal.throwIfAborted(); this.options.assertOwner(); input.beforeDispatch?.(); };
    const request = this.options.effects.track(async () => {
      assertDispatch();
      if (input.resetCookies) this.options.jar.delete(input.url.host);
      return sendHttp({ ...input, signal, isolatedConnection: true, jar: this.options.jar, beforeDispatch: assertDispatch });
    });
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request)).catch(() => undefined);
    return request;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(new Error('Native HTTP attempt closed'));
    this.closing = Promise.allSettled([...this.pending]).then(() => undefined);
    return this.closing;
  }
}

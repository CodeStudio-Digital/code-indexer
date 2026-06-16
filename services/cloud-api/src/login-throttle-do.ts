/**
 * LoginThrottleDO — a Durable Object that throttles failed login attempts for a
 * single key (v1: per client IP). Strongly consistent + serialized, so counts
 * can't race. After MAX_FAILS within WINDOW_MS the key is locked for LOCK_MS.
 * Exported from the Worker entry (index.ts) so the runtime can instantiate it.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

interface ThrottleState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export class LoginThrottleDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname;
    const now = Date.now();
    let s = (await this.state.storage.get<ThrottleState>('s')) ?? { count: 0, windowStart: now, lockedUntil: 0 };
    if (now - s.windowStart > WINDOW_MS) s = { count: 0, windowStart: now, lockedUntil: s.lockedUntil };

    if (action === '/check') {
      const locked = now < s.lockedUntil;
      return Response.json({ locked, retryAfterMs: locked ? s.lockedUntil - now : 0 });
    }
    if (action === '/fail') {
      s.count += 1;
      if (s.count >= MAX_FAILS) {
        s.lockedUntil = now + LOCK_MS;
        s.count = 0;
        s.windowStart = now;
      }
      await this.state.storage.put('s', s);
      const locked = now < s.lockedUntil;
      return Response.json({ locked, retryAfterMs: locked ? s.lockedUntil - now : 0 });
    }
    if (action === '/success') {
      await this.state.storage.put('s', { count: 0, windowStart: now, lockedUntil: 0 });
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}

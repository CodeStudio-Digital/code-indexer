/**
 * RateLimitDO — a SLIDING-WINDOW counter for ONE key (per `idFromName`).
 * Strongly consistent + serialized. We keep the timestamps of the hits still
 * inside the window; a request is allowed only if fewer than `limit` remain. This
 * avoids the ~2x burst a fixed window permits at the boundary (an attacker can't
 * fire `limit` just before the reset and `limit` again just after). The stored
 * array is bounded by `limit` (we only append on allow; expired entries drop off).
 * Exported from index.ts.
 */
interface State {
  hits: number[]; // epoch-ms timestamps, all within the current window
}

export class RateLimitDO {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const limit = Math.max(0, Number(url.searchParams.get('limit') ?? '0'));
    const windowMs = Math.max(0, Number(url.searchParams.get('windowMs') ?? '0'));
    const now = Date.now();

    const stored = await this.state.storage.get<State>('s');
    // Defensive: tolerate a missing/partial stored value (some runtimes hand back
    // an object without `hits` on first read) — treat it as an empty window.
    const s: State = { hits: Array.isArray(stored?.hits) ? stored!.hits : [] };
    s.hits = s.hits.filter((t) => now - t < windowMs); // slide: drop expired hits

    const allowed = s.hits.length < limit;
    if (allowed) s.hits.push(now);
    await this.state.storage.put('s', s);

    // When denied, a slot frees when the OLDEST surviving hit ages out.
    const retryAfterMs = allowed ? 0 : Math.max(0, s.hits[0] + windowMs - now);
    return Response.json({ allowed, retryAfterMs });
  }
}

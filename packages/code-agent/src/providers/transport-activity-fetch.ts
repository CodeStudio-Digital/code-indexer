/** Observe real response bytes without exposing payloads or parsing SSE twice.
 * Some SDKs discard keepalives before their public stream iterator sees them.
 * Backpressure and cancellation stay with the original response body.
 */
export function withTransportActivity(fetcher: typeof fetch, onActivity: () => void): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body?.pipeThrough || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > 0) {
          try { onActivity(); } catch { /* Observation must never fail a request. */ }
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

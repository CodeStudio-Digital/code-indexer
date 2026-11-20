import { HttpError, type HttpContext } from './context.js';
import type { MiddlewareHandler } from './router.js';

export function cors(options: { origin: (origin: string) => string | null | undefined; credentials?: boolean }): MiddlewareHandler {
  return async (c, next) => {
    const origin = options.origin(c.req.header('origin') ?? '');
    if (origin) c.header('Access-Control-Allow-Origin', origin);
    if (options.credentials) c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Vary', 'Origin', { append: true });

    if (c.req.method !== 'OPTIONS') return next();

    c.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,POST,DELETE,PATCH');
    const headers = c.req.header('Access-Control-Request-Headers');
    if (headers) {
      c.header('Access-Control-Allow-Headers', headers);
      c.header('Vary', 'Access-Control-Request-Headers', { append: true });
    }
    return c.body(null, 204);
  };
}

export function bodyLimit(options: { maxSize: number; onError?: (c: HttpContext) => Response }): MiddlewareHandler {
  const { maxSize, onError = () => new Response('Payload Too Large', { status: 413 }) } = options;
  return async (c, next) => {
    const request = c.req.raw;
    if (!request.body) return next();
    if (Number(request.headers.get('content-length')) > maxSize) return onError(c);

    let size = 0;
    let exceeded = false;
    const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        size += chunk.byteLength;
        if (size > maxSize) {
          exceeded = true;
          throw new HttpError(413, { message: 'Payload Too Large' });
        }
        output.enqueue(chunk);
      },
    }), { preventCancel: true });
    const init = { body, duplex: 'half' } as const;
    c.req.raw = new Request(request, init);
    await next();
    if (exceeded) return onError(c);
  };
}

import { HttpContext, HttpError, HttpRequest, type HttpEnvironment } from './context.js';

export type { HttpContext } from './context.js';
export type Next = () => Promise<void>;
type HttpHandler = (context: HttpContext, next: Next) => Response | void | Promise<Response | void>;
export type MiddlewareHandler = HttpHandler;

type Params = Readonly<Record<string, string>>;
type MatchPath = (path: string) => Params | undefined;
type ErrorHandler = (error: unknown, context: HttpContext) => Response | Promise<Response>;
type Route = {
  method: string;
  path: string;
  handlers: HttpHandler[];
  match: MatchPath;
};

const noParams: Params = Object.freeze(Object.create(null));

function decode(value: string, decoder: (text: string) => string): string {
  try { return decoder(value); } catch { return value; }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(pattern: string): MatchPath {
  if (pattern === '*' || pattern === '/*') return () => noParams;
  if (!pattern.includes(':') && !pattern.endsWith('/*')) {
    return path => path === pattern ? noParams : undefined;
  }

  const keys: string[] = [];
  const segments = pattern.slice(1).split('/');
  const wildcard = segments.at(-1) === '*';
  if (wildcard) segments.pop();
  const source = segments.map(segment => {
    if (!segment.startsWith(':')) return escapePattern(segment);
    keys.push(segment.slice(1));
    return '([^/]+)';
  }).join('/');
  const expression = new RegExp(`^/${source}${wildcard ? '(?:/.*)?' : ''}$`, 's');
  return path => {
    const match = expression.exec(path);
    if (!match || match[0].length !== path.length) return undefined;
    if (keys.length === 0) return noParams;
    const params: Record<string, string> = Object.create(null);
    keys.forEach((key, index) => { params[key] = decode(match[index + 1], decodeURIComponent); });
    return params;
  };
}

function notFound(): Response {
  return new Response('404 Not Found', { status: 404 });
}

function defaultError(error: unknown): Response {
  if (error instanceof HttpError) return error.toResponse();
  console.error(error);
  return new Response('Internal Server Error', { status: 500 });
}

/** Fetch request routing for the standalone API and desktop protocol handlers. */
export class HttpRouter {
  #routes: Route[] = [];
  #handleError: ErrorHandler = defaultError;

  get(path: string, ...handlers: HttpHandler[]): this { return this.on('GET', path, ...handlers); }
  post(path: string, ...handlers: HttpHandler[]): this { return this.on('POST', path, ...handlers); }
  put(path: string, ...handlers: HttpHandler[]): this { return this.on('PUT', path, ...handlers); }
  patch(path: string, ...handlers: HttpHandler[]): this { return this.on('PATCH', path, ...handlers); }
  delete(path: string, ...handlers: HttpHandler[]): this { return this.on('DELETE', path, ...handlers); }
  all(path: string, ...handlers: HttpHandler[]): this { return this.on('*', path, ...handlers); }
  use(path: string, ...handlers: HttpHandler[]): this { return this.all(path, ...handlers); }

  on(method: string, path: string | readonly string[], ...handlers: HttpHandler[]): this {
    for (const pattern of typeof path === 'string' ? [path] : path) {
      this.#routes.push({ method: method.toUpperCase(), path: pattern, handlers, match: compilePath(pattern) });
    }
    return this;
  }

  route(prefix: string, child: HttpRouter): this {
    const base = prefix.replace(/\/$/, '');
    for (const { method, path, handlers } of child.#routes) {
      if (!base) this.on(method, path, ...handlers);
      else this.on(method, path === '/' ? base : `${base}/${path.replace(/^\//, '')}`, ...handlers);
    }
    return this;
  }

  onError(handler: ErrorHandler): this {
    this.#handleError = handler;
    return this;
  }

  fetch = async (request: Request, env?: HttpEnvironment): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const path = pathname.includes('%') ? decode(pathname.replace(/%25/gi, '%2525'), decodeURI) : pathname;
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const context = new HttpContext(new HttpRequest(request, path), env);
    const matching: Array<{ handler: HttpHandler; params: Params }> = [];
    for (const route of this.#routes) {
      if (route.method !== '*' && route.method !== method) continue;
      const params = route.match(path);
      if (params) for (const handler of route.handlers) matching.push({ handler, params });
    }

    const dispatch = async (index: number): Promise<Response> => {
      const entry = matching[index];
      if (!entry) return notFound();
      context.req.setParams(entry.params);
      let downstream: Response | undefined;
      let continued = false;
      try {
        const reply = await entry.handler(context, async () => {
          if (continued) throw new Error('next() called more than once');
          continued = true;
          downstream = await dispatch(index + 1);
          context.req.setParams(entry.params);
        });
        if (reply) return reply;
        if (downstream) return downstream;
        throw new Error('Route produced no response');
      } catch (error) {
        return await this.#handleError(error, context);
      }
    };

    const response = context.applyHeaders(await dispatch(0));
    if (request.method !== 'HEAD') return response;
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  request(input: string | URL | Request, init?: RequestInit, env?: HttpEnvironment): Promise<Response> {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input, 'http://localhost'), init);
    return this.fetch(request, env);
  }
}

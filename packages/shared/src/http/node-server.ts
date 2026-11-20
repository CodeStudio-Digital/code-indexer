import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { HttpEnvironment } from './context.js';

type FetchHandler = (request: Request, env: HttpEnvironment) => Response | Promise<Response>;

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const method = incoming.method ?? 'GET';
  const target = incoming.url || '/';
  const url = target.startsWith('/') ? `http://${incoming.headers.host ?? 'localhost'}${target}` : target;
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
    else if (value !== undefined) headers.set(key, value);
  }

  const hasBody = method !== 'GET' && method !== 'HEAD'
    && (Number(headers.get('content-length')) > 0 || headers.has('transfer-encoding'));
  if (!hasBody) return new Request(url, { method, headers, signal });

  const body = Readable.toWeb(incoming, {
    strategy: { highWaterMark: incoming.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as ReadableStream<Uint8Array>;
  const init = { method, headers, signal, body, duplex: 'half' } as const;
  return new Request(url, init);
}

async function writeResponse(response: Response, outgoing: ServerResponse, head: boolean): Promise<void> {
  if (outgoing.destroyed || head) {
    void response.body?.cancel().catch(() => undefined);
    if (outgoing.destroyed) return;
  }

  outgoing.statusCode = response.status;
  if (response.statusText) outgoing.statusMessage = response.statusText;
  for (const [key, value] of response.headers) {
    if (key !== 'set-cookie') outgoing.setHeader(key, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('set-cookie', cookies);

  if (head || !response.body) {
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  const body = response.body as Parameters<typeof Readable.fromWeb>[0];
  await pipeline(Readable.fromWeb(body), outgoing);
}

async function handleRequest(incoming: IncomingMessage, outgoing: ServerResponse, fetch: FetchHandler): Promise<void> {
  const controller = new AbortController();
  const abortRequest = () => { if (!incoming.complete) controller.abort(); };
  const abortResponse = () => { if (!outgoing.writableFinished) controller.abort(); };
  incoming.once('close', abortRequest);
  outgoing.once('close', abortResponse);
  try {
    let request: Request;
    try {
      request = toRequest(incoming, controller.signal);
    } catch {
      outgoing.writeHead(400).end('Bad Request');
      return;
    }
    const response = await fetch(request, { incoming });
    await writeResponse(response, outgoing, request.method === 'HEAD');
  } catch (error) {
    if (controller.signal.aborted || outgoing.destroyed) return;
    console.error(error);
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(500).end('Internal Server Error');
  } finally {
    incoming.off('close', abortRequest);
    outgoing.off('close', abortResponse);
  }
}

export function listenHttp(options: { fetch: FetchHandler; port: number; hostname: string }, onListen?: () => void): Server {
  const server = createServer((req, res) => { void handleRequest(req, res, options.fetch); });
  return server.listen(options.port, options.hostname, onListen);
}

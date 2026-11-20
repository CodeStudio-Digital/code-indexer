import type { HttpContext } from './context.js';

interface SseMessage {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

interface SseStream {
  writeSSE(message: SseMessage): Promise<void>;
  onAbort(callback: () => void): void;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

function frame(message: SseMessage): Uint8Array<ArrayBuffer> {
  const { data, event, id, retry } = message;
  const lines: string[] = [];
  if (event) lines.push(field('event', event));
  for (const line of data.split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
  if (id !== undefined) lines.push(field('id', id));
  if (retry !== undefined) lines.push(field('retry', String(retry)));
  return encoder.encode(`${lines.join('\n')}\n\n`);
}

function field(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid SSE ${name}`);
  return `${name}: ${value}`;
}

export function streamSSE(c: HttpContext, run: (stream: SseStream) => void | Promise<void>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const signal = c.req.raw.signal;
  const callbacks = new Set<() => void>();
  let aborted = false;
  let closing: Promise<void> | undefined;

  const cleanup = () => {
    signal.removeEventListener('abort', abort);
    callbacks.clear();
  };
  const abort = () => {
    if (aborted) return;
    aborted = true;
    for (const callback of callbacks) {
      try { callback(); } catch (error) { console.error(error); }
    }
    cleanup();
    void writer.abort(signal.reason).catch(() => undefined);
  };
  const stream: SseStream = {
    async writeSSE(message) {
      if (aborted || closing) return;
      const chunk = frame(message);
      try { await writer.write(chunk); } catch { abort(); }
    },
    onAbort(callback) {
      if (aborted) callback();
      else callbacks.add(callback);
    },
    close() {
      return closing ??= writer.close().catch(error => {
        if (!aborted) throw error;
      });
    },
  };

  void writer.closed.then(cleanup, abort);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  void Promise.resolve().then(() => run(stream)).catch(error => {
    if (!aborted) console.error(error);
  }).then(() => stream.close()).catch(error => { if (!aborted) console.error(error); });

  return c.body(readable, 200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
}

import { createHash } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

type Event = Record<string, unknown>;
type Request = Record<string, unknown> & { input: unknown[] };
interface Prefix { responseId: string; config: string; fields: Record<string, string>; items: string[] }
interface Connection {
  socket: WebSocket;
  busy: boolean;
  prefix: Prefix | null;
  idle?: ReturnType<typeof setTimeout>;
  receive?: (event: Event, bytes: number) => void;
  fail?: (error: Error) => void;
}
export interface CodexSocketStream {
  stream: AsyncIterable<Event>;
  inputItems: number;
  incremental: boolean;
  continuationReason: string;
  changedConfigFields: string[];
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const socketError = (message: string, code = 'provider_stream_incomplete') => Object.assign(new Error(message), { code });

/** Per-session connections. No cross-session response IDs, no replay after a request was sent. */
export class CodexResponsesWebSocket {
  private readonly connections = new Map<string, Connection>();
  private unsupported = false;

  constructor(private readonly url: string, private readonly headers: Record<string, string>,
    private readonly idleMs = 120_000) {}

  close(): void {
    for (const [key, connection] of this.connections) this.drop(key, connection);
  }

  private drop(key: string, connection: Connection): void {
    if (this.connections.get(key) === connection) this.connections.delete(key);
    clearTimeout(connection.idle);
    connection.prefix = null;
    connection.socket.terminate();
  }

  private async connect(key: string, signal?: AbortSignal): Promise<Connection | null> {
    if (this.unsupported) return null;
    signal?.throwIfAborted();
    const existing = this.connections.get(key);
    if (existing?.busy) return null; // A shared provider must not multiplex unrelated active requests.
    if (existing?.socket.readyState === WebSocket.OPEN) {
      clearTimeout(existing.idle);
      existing.busy = true;
      return existing;
    }
    if (existing) this.drop(key, existing);
    if (this.connections.size >= 8) {
      const idle = [...this.connections].find(([, connection]) => !connection.busy);
      if (!idle) return null;
      this.drop(...idle);
    }
    const socket = new WebSocket(this.url, {
      headers: { ...this.headers, session_id: key, 'OpenAI-Beta': 'responses_websockets=2026-02-06' },
      handshakeTimeout: 5_000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false,
    });
    const connection: Connection = { socket, busy: true, prefix: null };
    this.connections.set(key, connection);
    // A persistent listener prevents idle close/error events from becoming unhandled.
    socket.on('error', (error) => connection.fail?.(error));
    socket.on('close', () => {
      if (this.connections.get(key) === connection) this.connections.delete(key);
      clearTimeout(connection.idle);
      connection.fail?.(socketError('Codex WebSocket closed before response.completed'));
    });
    socket.on('message', (raw: RawData) => {
      try {
        const text = raw.toString();
        const event: unknown = JSON.parse(text);
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event');
        connection.receive?.(event as Event, Buffer.byteLength(text));
      } catch {
        connection.fail?.(socketError('Invalid Codex WebSocket JSON', 'provider_invalid_json'));
        this.drop(key, connection);
      }
    });
    return new Promise<Connection | null>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        socket.off('error', onError);
        socket.off('unexpected-response', onResponse);
        socket.off('open', onOpen);
      };
      const onAbort = () => { cleanup(); this.drop(key, connection); reject(signal!.reason); };
      const onError = () => {
        cleanup(); this.drop(key, connection);
        // Nothing was sent. Use HTTP for this provider instance if the network blocks WS.
        this.unsupported = true;
        resolve(null);
      };
      const onResponse = (_request: unknown, response: import('node:http').IncomingMessage) => {
        response.resume();
        onError();
      };
      const onOpen = () => { cleanup(); resolve(connection); };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('unexpected-response', onResponse);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async open(key: string, request: Request, signal?: AbortSignal,
    onActivity?: () => void): Promise<CodexSocketStream | null> {
    const connection = await this.connect(key, signal);
    if (!connection) return null;
    if (signal?.aborted) { this.drop(key, connection); signal.throwIfAborted(); }
    const { stream: _stream, background: _background, previous_response_id: _previous, input, ...config } = request;
    const configHash = digest(config);
    const configFields = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, digest(value)]));
    const hashes = input.map(digest);
    const prefix = connection.prefix;
    const incremental = !!prefix && prefix.config === configHash && hashes.length > prefix.items.length
      && prefix.items.every((hash, index) => hashes[index] === hash);
    const changedConfigFields = prefix ? [...new Set([...Object.keys(prefix.fields), ...Object.keys(configFields)])]
      .filter(name => prefix.fields[name] !== configFields[name]) : [];
    const continuationReason = incremental ? 'reused' : !prefix ? 'new_connection_or_no_response'
      : prefix.config !== configHash ? 'configuration_changed'
      : hashes.length <= prefix.items.length ? 'history_not_extended' : 'history_prefix_changed';
    const payload = {
      ...config, type: 'response.create',
      input: incremental ? input.slice(prefix!.items.length) : input,
      ...(incremental ? { previous_response_id: prefix!.responseId } : {}),
    };
    // Queue starts before send so a fast response cannot be lost before the consumer iterates.
    const queue: Array<{ event: Event; bytes: number }> = [];
    let queuedBytes = 0;
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let terminal = false;
    let retriedFull = false;
    let sawOutput = false;
    const metrics = { inputItems: payload.input.length, incremental, continuationReason };
    connection.fail = (error) => { failure ??= error; wake?.(); };
    connection.receive = (event, bytes) => {
      onActivity?.();
      if (queue.length >= 4096 || queuedBytes + bytes > 16 * 1024 * 1024) {
        connection.fail?.(socketError('Codex WebSocket response buffer exceeded', 'provider_buffer_limit'));
        this.drop(key, connection);
        return;
      }
      queue.push({ event, bytes }); queuedBytes += bytes; wake?.();
    };
    const abort = () => {
      connection.fail?.(socketError('Codex WebSocket request aborted', 'ABORT_ERR'));
      this.drop(key, connection);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else connection.socket.send(JSON.stringify(payload), (error) => { if (error) connection.fail?.(error); });
    const owner = this;
    const stream = (async function* (): AsyncIterable<Event> {
      try {
        while (true) {
          signal?.throwIfAborted();
          const next = queue.shift();
          if (!next) {
            if (failure) throw failure;
            await new Promise<void>((resolve) => { wake = resolve; }); wake = undefined; continue;
          }
          queuedBytes -= next.bytes;
          const event = next.event;
          const code = (event.error as { code?: string } | undefined)?.code;
          if (event.type === 'error' && code === 'previous_response_not_found' && incremental
            && !retriedFull && !sawOutput && connection.socket.readyState === WebSocket.OPEN) {
            // The server explicitly rejected the missing reference before generation.
            // Retry once with complete, durable input; other failures go to the runner.
            retriedFull = true; connection.prefix = null;
            metrics.incremental = false; metrics.inputItems = input.length;
            metrics.continuationReason = 'server_reference_not_found';
            connection.socket.send(JSON.stringify({ ...config, type: 'response.create', input }),
              (error) => { if (error) connection.fail?.(error); });
            continue;
          }
          if (/^response\.(output|reasoning|function_call|custom_tool_call)/.test(String(event.type))) sawOutput = true;
          if (event.type === 'response.completed') {
            terminal = true;
            const response = event.response as { id?: string; output?: unknown[] } | undefined;
            connection.prefix = response?.id && Array.isArray(response.output)
              ? { responseId: response.id, config: configHash, fields: configFields, items: [...hashes, ...response.output.map(digest)] } : null;
            yield event;
            return;
          }
          if (['response.failed', 'response.incomplete', 'error'].includes(String(event.type))) {
            connection.prefix = null;
            yield event;
            return;
          }
          yield event;
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        connection.receive = undefined; connection.fail = undefined; connection.busy = false;
        if (!terminal || connection.socket.readyState !== WebSocket.OPEN) owner.drop(key, connection);
        else {
          connection.idle = setTimeout(() => owner.drop(key, connection), owner.idleMs);
          connection.idle.unref();
        }
      }
    })();
    return { stream, get inputItems() { return metrics.inputItems; }, get incremental() { return metrics.incremental; },
      get continuationReason() { return metrics.continuationReason; }, changedConfigFields };
  }
}

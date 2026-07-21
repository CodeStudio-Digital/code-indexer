import { createConnection, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';

export interface DapRequest {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
}

export interface DapResponse<T = unknown> {
  seq: number;
  type: 'response';
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: T;
}

export interface DapEvent<T = unknown> {
  seq: number;
  type: 'event';
  event: string;
  body?: T;
}

type DapMessage = DapRequest | DapResponse | DapEvent;
type ReverseRequestHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_DAP_MESSAGE_BYTES = 16 * 1024 * 1024;

export class DapConnection {
  private sequence = 1;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;
  private readonly pending = new Map<number, {
    command: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly events = new Map<string, Set<(body: unknown) => void>>();
  private readonly reverseRequests = new Map<string, ReverseRequestHandler>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on('data', (chunk: Buffer | string) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    input.on('error', (error) => this.close(error));
    input.on('close', () => this.close());
    output.on('error', (error) => this.close(error));
  }

  request<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DAP connection is closed'));
    const seq = this.sequence++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(seq, {
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send({ seq, type: 'request', command, arguments: args });
    });
  }

  onEvent<T = unknown>(event: string, listener: (body: T) => void): () => void {
    const listeners = this.events.get(event) ?? new Set();
    listeners.add(listener as (body: unknown) => void);
    this.events.set(event, listeners);
    return () => listeners.delete(listener as (body: unknown) => void);
  }

  waitForEvent<T = unknown>(event: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.onEvent<T>(event, (body) => {
        clearTimeout(timer);
        off();
        offClose();
        resolve(body);
      });
      const offClose = this.onClose((error) => {
        clearTimeout(timer);
        off();
        reject(error ?? new Error(`DAP connection closed while waiting for '${event}'`));
      });
      const timer = setTimeout(() => {
        off();
        offClose();
        reject(new Error(`DAP event '${event}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  onRequest(command: string, handler: ReverseRequestHandler): () => void {
    this.reverseRequests.set(command, handler);
    return () => {
      if (this.reverseRequests.get(command) === handler) this.reverseRequests.delete(command);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error('DAP connection closed'));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    const input = this.input as Readable & { destroy?: (error?: Error) => void };
    const output = this.output as Writable & { destroy?: (error?: Error) => void };
    input.destroy?.();
    if ((output as unknown) !== (input as unknown)) output.destroy?.();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buffer.length > 8 * 1024) this.close(new Error('invalid DAP header'));
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
      if (!match) {
        this.close(new Error('DAP message has no Content-Length header'));
        return;
      }
      const contentLength = Number(match[1]);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_DAP_MESSAGE_BYTES) {
        this.close(new Error(`invalid DAP Content-Length: ${match[1]}`));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        this.dispatch(JSON.parse(body.toString('utf8')) as DapMessage);
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private dispatch(message: DapMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.body);
      else pending.reject(new Error(message.message ?? `DAP request '${pending.command}' failed`));
      return;
    }
    if (message.type === 'event') {
      for (const listener of this.events.get(message.event) ?? []) listener(message.body);
      return;
    }
    void this.handleReverseRequest(message);
  }

  private async handleReverseRequest(request: DapRequest): Promise<void> {
    const handler = this.reverseRequests.get(request.command);
    try {
      if (!handler) throw new Error(`unsupported reverse DAP request '${request.command}'`);
      const body = await handler(request.arguments ?? {});
      this.send({
        seq: this.sequence++,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: true,
        body,
      });
    } catch (error) {
      this.send({
        seq: this.sequence++,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(message: DapMessage): void {
    if (this.closed) return;
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json, 'utf8');
    this.output.write(`Content-Length: ${bytes}\r\n\r\n${json}`, 'utf8');
  }
}

export function connectDapTcp(host: string, port: number, timeoutMs = 5_000): Promise<{ socket: Socket; dap: DapConnection }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to DAP server at ${host}:${port}`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ socket, dap: new DapConnection(socket, socket) });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

import { once } from 'node:events';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  type EngineJsonRpcTransport,
  JsonRpcProtocolError,
} from './JsonRpcPeer.js';

export interface NodeJsonLineTransportOptions {
  maxLineBytes?: number;
  endWritableOnClose?: boolean;
  onClose?: () => void | Promise<void>;
}
export class NodeJsonLineTransport implements EngineJsonRpcTransport {
  readonly #reader: Interface;
  readonly #maxLineBytes: number;
  readonly #endWritableOnClose: boolean;
  readonly #onClose?: () => void | Promise<void>;
  #closed = false;
  #iterated = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    options: NodeJsonLineTransportOptions = {},
  ) {
    this.#reader = createInterface({ input, crlfDelay: Infinity });
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#endWritableOnClose = options.endWritableOnClose ?? false;
    this.#onClose = options.onClose;
  }

  async send(message: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.#closed) {
      throw new JsonRpcProtocolError('transport_closed', 'JSONL transport is closed');
    }
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > this.#maxLineBytes) {
      throw new JsonRpcProtocolError(
        'outbound_message_limit',
        `JSONL message uses ${bytes} bytes; limit is ${this.#maxLineBytes}`,
      );
    }
    if (!this.output.write(line, 'utf8')) {
      await once(this.output, 'drain');
    }
  }

  async *messages(): AsyncIterable<unknown> {
    if (this.#iterated) {
      throw new JsonRpcProtocolError('transport_already_iterated', 'JSONL input has one consumer');
    }
    this.#iterated = true;
    for await (const line of this.#reader) {
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > this.#maxLineBytes) {
        throw new JsonRpcProtocolError(
          'inbound_line_limit',
          `JSONL line uses ${bytes} bytes; limit is ${this.#maxLineBytes}`,
        );
      }
      if (line.trim().length === 0) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        throw new JsonRpcProtocolError('invalid_json_line', 'JSONL transport received invalid JSON');
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    if (this.#endWritableOnClose) this.output.end();
    await this.#onClose?.();
  }
}

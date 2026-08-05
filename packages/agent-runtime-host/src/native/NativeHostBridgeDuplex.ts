import { Duplex } from 'node:stream';
import type {
  NativeHostBridgeCloseAuthority,
} from './NativeHostBridgeClose.js';

export const NATIVE_HOST_TRANSPORT_CHUNK_BYTES = 64 * 1024;

type NativeChannelKind = 'control' | 'data';
type WriteCallback = (error?: Error | null) => void;

/** Adapts bounded native async I/O to the existing Node stream framing seam. */
export class NativeHostBridgeDuplex extends Duplex {
  readonly #kind: NativeChannelKind;
  readonly #authority: NativeHostBridgeCloseAuthority;
  #reading = false;
  #continueReading = false;

  constructor(
    kind: NativeChannelKind,
    authority: NativeHostBridgeCloseAuthority,
  ) {
    super({
      // Control and Data share one native close authority. A clean EOF on one
      // read half must not tear down the sibling while its terminal ACK is in
      // flight; pair cleanup is owned by the attempt lifecycle.
      allowHalfOpen: true,
      autoDestroy: false,
      decodeStrings: true,
      highWaterMark: NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
    });
    this.#kind = kind;
    this.#authority = authority;
  }

  override _read(): void {
    if (this.#reading || this.destroyed) return;
    this.#reading = true;
    let read: Promise<Uint8Array | null>;
    try {
      read = this.#authority.read(
        this.#kind,
        NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
      );
    } catch (cause) {
      this.#reading = false;
      this.destroy(asError(cause));
      return;
    }
    void read.then(
      (bytes) => this.#completeRead(bytes),
      (cause) => this.destroy(asError(cause)),
    ).finally(() => {
      this.#reading = false;
      if (this.#continueReading && !this.destroyed) {
        this.#continueReading = false;
        queueMicrotask(() => this._read());
      }
    });
  }

  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: WriteCallback,
  ): void {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      callback(new TypeError('native Host bridge write requires bytes'));
      return;
    }
    const isolated = Buffer.from(chunk);
    void this.#authority.write(this.#kind, isolated).then(
      () => callback(),
      (cause) => callback(asError(cause)),
    ).finally(() => isolated.fill(0));
  }

  override _final(callback: WriteCallback): void {
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: WriteCallback,
  ): void {
    // Stream failure is reported to the semantic adapter. Only the endpoint
    // pair owns the shared native close authority and decides when both
    // Control and Data may be torn down.
    callback(error);
  }

  #completeRead(value: Uint8Array | null): void {
    if (value === null) {
      this.push(null);
      return;
    }
    if (
      !(value instanceof Uint8Array)
      || value.byteLength === 0
      || value.byteLength > NATIVE_HOST_TRANSPORT_CHUNK_BYTES
    ) {
      if (value instanceof Uint8Array) value.fill(0);
      this.destroy(new TypeError(
        'native Host bridge returned an invalid read chunk',
      ));
      return;
    }
    const isolated = Buffer.from(value);
    value.fill(0);
    if (this.destroyed) {
      isolated.fill(0);
      return;
    }
    this.#continueReading = this.push(isolated);
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error('native Host bridge transport failed', { cause });
}

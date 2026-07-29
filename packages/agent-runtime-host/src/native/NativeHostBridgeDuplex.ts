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

  constructor(
    kind: NativeChannelKind,
    authority: NativeHostBridgeCloseAuthority,
  ) {
    super({
      allowHalfOpen: false,
      autoDestroy: true,
      decodeStrings: true,
      highWaterMark: NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
    });
    this.#kind = kind;
    this.#authority = authority;
  }

  override _read(): void {
    if (this.#reading || this.destroyed) return;
    this.#reading = true;
    void this.#authority.read(
      this.#kind,
      NATIVE_HOST_TRANSPORT_CHUNK_BYTES,
    ).then(
      (bytes) => this.#completeRead(bytes),
      (cause) => this.destroy(asError(cause)),
    ).finally(() => {
      this.#reading = false;
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
    void this.#authority.close().then(
      () => callback(),
      (cause) => callback(asError(cause)),
    );
  }

  override _destroy(
    error: Error | null,
    callback: WriteCallback,
  ): void {
    void this.#authority.close().then(
      () => callback(error),
      (cause) => callback(error ?? asError(cause)),
    );
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
    this.push(isolated);
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error('native Host bridge transport failed', { cause });
}

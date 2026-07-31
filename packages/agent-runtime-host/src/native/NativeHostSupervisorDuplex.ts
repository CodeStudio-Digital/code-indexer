import { Duplex } from 'node:stream';
import type {
  NativeHostSupervisorCloseAuthority,
} from './NativeHostSupervisorClose.js';

type WriteCallback = (error?: Error | null) => void;

/** Adapts the native management stream without proxying protocol semantics. */
export class NativeHostSupervisorDuplex extends Duplex {
  readonly #authority: NativeHostSupervisorCloseAuthority;
  readonly #chunkBytes: number;
  #reading = false;
  #continueReading = false;

  constructor(
    authority: NativeHostSupervisorCloseAuthority,
    chunkBytes: number,
  ) {
    super({
      allowHalfOpen: false,
      autoDestroy: true,
      decodeStrings: true,
      highWaterMark: chunkBytes,
    });
    if (
      !Number.isInteger(chunkBytes)
      || chunkBytes <= 0
      || chunkBytes > 64 * 1024
    ) throw new RangeError('native management transport chunk cap is invalid');
    this.#authority = authority;
    this.#chunkBytes = chunkBytes;
  }

  override _read(): void {
    if (this.#reading || this.destroyed) return;
    this.#reading = true;
    void this.#authority.read(this.#chunkBytes).then(
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
    if (
      !(chunk instanceof Uint8Array)
      || chunk.byteLength === 0
      || chunk.byteLength > this.#chunkBytes
    ) {
      callback(new TypeError('native management write chunk is invalid'));
      return;
    }
    const isolated = Buffer.from(chunk);
    void this.#authority.write(isolated).then(
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

  override _destroy(error: Error | null, callback: WriteCallback): void {
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
      || value.byteLength > this.#chunkBytes
    ) {
      if (value instanceof Uint8Array) value.fill(0);
      this.destroy(new TypeError(
        'native management bridge returned an invalid read chunk',
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
    : new Error('native Host supervisor transport failed', { cause });
}

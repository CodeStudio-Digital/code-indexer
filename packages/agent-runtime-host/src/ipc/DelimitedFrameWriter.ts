import type { Writable } from 'node:stream';
import { DelimitedChannelError } from './DelimitedChannelError.js';

interface ActiveWrite {
  frame?: Uint8Array;
  prefix: Uint8Array;
  phase: 'prefix' | 'frame';
  offset: number;
  reject: (error: DelimitedChannelError) => void;
  resolve: () => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export class DelimitedFrameWriter {
  #active?: ActiveWrite;

  constructor(
    private readonly writable: Writable,
    private readonly maximumChunkBytes: number,
  ) {}

  write(frame: Uint8Array, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const active: ActiveWrite = {
        frame,
        prefix: encodeLength(frame.byteLength),
        phase: 'prefix',
        offset: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.abort(new DelimitedChannelError(
            'write_timeout',
            'transport frame write timeout',
          ));
        }, timeoutMs),
        settled: false,
      };
      active.timer.unref();
      this.#active = active;
      this.#advance(active);
    });
  }

  abort(error: DelimitedChannelError): void {
    const active = this.#active;
    if (!active || active.settled) return;
    active.frame = undefined;
    active.settled = true;
    clearTimeout(active.timer);
    this.#active = undefined;
    active.reject(error);
  }

  #advance(active: ActiveWrite): void {
    if (active.settled || this.#active !== active) return;
    const source = active.phase === 'prefix' ? active.prefix : active.frame;
    if (!source) return;
    if (active.offset === source.byteLength) {
      if (active.phase === 'prefix') {
        active.phase = 'frame';
        active.offset = 0;
        this.#advance(active);
      } else {
        this.#finish(active);
      }
      return;
    }
    const length = Math.min(
      this.maximumChunkBytes,
      source.byteLength - active.offset,
    );
    // A Writable may retain or even mutate the chunk after its callback. Give
    // ownership of a bounded disposable chunk to the endpoint so the
    // authority/replay buffer is never exposed.
    const isolated = source.slice(active.offset, active.offset + length);
    try {
      this.writable.write(isolated, (error?: Error | null) => {
        if (active.settled) return;
        if (error) {
          this.abort(new DelimitedChannelError(
            'transport_error',
            'frame write failed',
            { cause: error },
          ));
          return;
        }
        active.offset += length;
        queueMicrotask(() => this.#advance(active));
      });
    } catch (cause) {
      this.abort(new DelimitedChannelError(
        'transport_error',
        'frame write failed',
        { cause },
      ));
    }
  }

  #finish(active: ActiveWrite): void {
    active.frame = undefined;
    active.settled = true;
    clearTimeout(active.timer);
    this.#active = undefined;
    active.resolve();
  }
}

function encodeLength(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
}

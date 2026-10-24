
export const DEFAULT_MAX_OUTPUT_BYTES = 100_000;

export const OUTPUT_HEAD_RATIO = 0.55;


export function omissionMarker(omittedBytes: number): Buffer {
  return Buffer.from(
    `\n[truncated: ${omittedBytes} bytes omitted; preserved beginning and true tail]\n`,
    'utf-8',
  );
}


export function utf8SequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}


/** Do not turn a byte-budget boundary into a Unicode replacement character. */
export function utf8SafePrefix(source: Buffer, maxBytes: number): Buffer {
  let end = Math.min(source.length, Math.max(0, maxBytes));
  if (end === source.length || end === 0) return source.subarray(0, end);

  let lead = end - 1;
  while (lead >= 0 && (source[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0 || lead + utf8SequenceLength(source[lead]) > end) end = Math.max(0, lead);
  return source.subarray(0, end);
}


/** Skip leading continuation bytes when retaining a UTF-8 suffix. */
export function utf8SafeSuffix(source: Buffer, maxBytes: number): Buffer {
  let start = Math.max(0, source.length - Math.max(0, maxBytes));
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1;
  return source.subarray(start);
}


/**
 * Format already-bounded head/tail buffers inside `maxBytes`, including the
 * marker. `totalBytes` is the number of raw bytes observed from the process,
 * so the marker remains exact even though the omitted middle was never kept
 * in memory.
 */
export function formatBoundedBuffers(
  head: Buffer,
  tail: Buffer,
  totalBytes: number,
  maxBytes: number,
): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (limit === 0) return '';

  let omittedBytes = Math.max(1, totalBytes - limit);
  let marker = omissionMarker(omittedBytes);
  let headBytes = 0;
  let tailBytes = 0;
  let selectedHead: Buffer = Buffer.alloc(0);
  let selectedTail: Buffer = Buffer.alloc(0);

  // The marker's digit count affects the retained budget, and the retained
  // budget affects the omitted count. Iterate to the tiny fixed point.
  let stable = false;
  for (let i = 0; i < 32; i += 1) {
    if (marker.length >= limit) break;
    const available = Math.max(0, limit - marker.length);
    const desiredHead = Math.floor(available * OUTPUT_HEAD_RATIO);
    selectedHead = utf8SafePrefix(head, desiredHead);
    selectedTail = utf8SafeSuffix(tail, available - selectedHead.length);
    headBytes = selectedHead.length;
    tailBytes = selectedTail.length;

    const nextOmitted = Math.max(0, totalBytes - headBytes - tailBytes);
    if (nextOmitted === omittedBytes) {
      stable = true;
      break;
    }
    omittedBytes = nextOmitted;
    marker = omissionMarker(omittedBytes);
  }

  if (!stable || marker.length >= limit) {
    // Pathological tiny limits cannot fit the descriptive marker. Still keep
    // the allocation bounded and make truncation explicit.
    return Buffer.from(`[truncated:${totalBytes}B]`, 'utf-8')
      .subarray(0, limit)
      .toString('utf-8');
  }

  return Buffer.concat([
    selectedHead,
    marker,
    selectedTail,
  ]).toString('utf-8');
}


/**
 * Bound an already-materialized string without losing its true tail. This is
 * also used by the tool layer as a defensive fallback for remote shell
 * adapters that cannot stream through `LocalShellAdapter`.
 */
export function boundUtf8OutputDetailed(
  content: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): { content: string; truncation?: { inputBytes: number; outputBytes: number } } {
  const source = Buffer.from(content, 'utf-8');
  if (source.length <= maxBytes) return { content };
  const bounded = formatBoundedBuffers(source, source, source.length, maxBytes);
  return {
    content: bounded,
    truncation: {
      inputBytes: source.length,
      outputBytes: Buffer.byteLength(bounded, 'utf-8'),
    },
  };
}


export function boundUtf8Output(content: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  return boundUtf8OutputDetailed(content, maxBytes).content;
}


/** A memory-bounded process stream capture with exact omission accounting. */
export class BoundedUtf8Capture {
  private readonly maxBytes: number;
  private readonly headCapacity: number;
  private readonly tailCapacity: number;
  private totalBytes = 0;
  private full: Buffer | null = Buffer.alloc(0);
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.headCapacity = Math.floor(this.maxBytes * OUTPUT_HEAD_RATIO);
    this.tailCapacity = this.maxBytes - this.headCapacity;
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;

    if (this.full !== null) {
      if (this.full.length + bytes.length <= this.maxBytes) {
        this.full = Buffer.concat([this.full, bytes]);
        return;
      }

      // Buffer.concat with an explicit shorter length copies only the prefix;
      // it does not allocate the potentially huge combined stream.
      this.head = Buffer.concat([this.full, bytes], this.headCapacity);
      this.tail = this.keepTail(this.full, bytes);
      this.full = null;
      return;
    }

    this.tail = this.keepTail(this.tail, bytes);
  }

  finish(): string {
    return this.finishDetailed().content;
  }

  finishDetailed(): {
    content: string;
    truncation?: { inputBytes: number; outputBytes: number };
  } {
    if (this.full !== null) return { content: this.full.toString('utf-8') };
    const content = formatBoundedBuffers(
      this.head,
      this.tail,
      this.totalBytes,
      this.maxBytes,
    );
    return {
      content,
      truncation: {
        inputBytes: this.totalBytes,
        outputBytes: Buffer.byteLength(content, 'utf-8'),
      },
    };
  }

  private keepTail(previous: Buffer, chunk: Buffer): Buffer {
    if (this.tailCapacity === 0) return Buffer.alloc(0);
    if (chunk.length >= this.tailCapacity) {
      return Buffer.from(chunk.subarray(chunk.length - this.tailCapacity));
    }
    const previousBytes = Math.min(previous.length, this.tailCapacity - chunk.length);
    return Buffer.concat([
      previous.subarray(previous.length - previousBytes),
      chunk,
    ]);
  }
}

/**
 * LSP base-protocol framing: `Content-Length: N\r\n\r\n{json}` where N is
 * the body length in BYTES of UTF-8 — NOT `string.length` (the classic bug
 * with accents/emoji). Note this is NOT the MCP SDK's stdio transport
 * (that one is newline-delimited JSON); LSP servers reject NDJSON.
 */

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf-8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

/**
 * Incremental parser for the server's stdout. Push raw chunks in any
 * fragmentation (half a header, three messages at once); complete JSON
 * messages come out in order. Malformed JSON bodies are surfaced to
 * `onError` and skipped — one bad frame must not kill the connection.
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;

  constructor(private onError?: (err: Error) => void) {}

  append(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  hasCompleteMessage(): boolean {
    if (this.expectedLength !== null) return this.buffer.length >= this.expectedLength;
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return false;
    const match = /content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) return true; // drain() can discard the malformed header and resync.
    return this.buffer.length >= headerEnd + 4 + Number(match[1]);
  }

  drain(maxMessages = Number.POSITIVE_INFINITY, maxBytes = Number.POSITIVE_INFINITY): unknown[] {
    const messages: unknown[] = [];
    let bytesProcessed = 0;

    for (; messages.length < maxMessages && bytesProcessed < maxBytes;) {
      if (this.expectedLength === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          this.onError?.(new Error(`LSP frame without Content-Length: ${header.slice(0, 120)}`));
          this.buffer = this.buffer.subarray(headerEnd + 4);
          bytesProcessed += headerEnd + 4;
          continue;
        }
        this.expectedLength = Number(match[1]);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        bytesProcessed += headerEnd + 4;
      }

      if (this.buffer.length < this.expectedLength) break;
      const body = this.buffer.subarray(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      bytesProcessed += this.expectedLength;
      this.expectedLength = null;
      try {
        messages.push(JSON.parse(body.toString('utf-8')));
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return messages;
  }

  push(chunk: Buffer): unknown[] {
    this.append(chunk);
    return this.drain();
  }
}

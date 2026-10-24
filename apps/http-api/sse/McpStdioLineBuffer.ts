import { deserializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Retains at most one bounded line; concatenates once instead of on every chunk. */
export class McpStdioLineBuffer {
  private parts: Buffer[] = [];
  private bytes = 0;
  *push(chunk: Uint8Array): Generator<JSONRPCMessage> {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset);
      const end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(offset, end);
      if (this.bytes + part.length > 4 * 1024 * 1024) throw new Error('MCP stdio frame exceeds 4 MiB');
      this.parts.push(part); this.bytes += part.length;
      if (newline < 0) return;
      const text = Buffer.concat(this.parts, this.bytes).toString('utf8').replace(/\r$/, '');
      this.parts = []; this.bytes = 0;
      yield deserializeMessage(text);
      offset = newline + 1;
    }
  }
  assertComplete(): void { if (this.bytes) throw new Error('MCP stdio ended with an incomplete frame'); }
  clear(): void { this.parts = []; this.bytes = 0; }
}

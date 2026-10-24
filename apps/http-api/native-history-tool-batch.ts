import type { AgentMessage } from '@mcp/provider-sdk/wire.js';

export interface NativeHistoryToolResult {
  id: string;
  name?: string;
  result: { content: string; isError: boolean; truncated?: boolean; originalSize?: number;
    effectOutcome?: 'unknown'; extraUserMessageHex?: string };
}

/** Live events retain completion order. The durable transcript is projected in
 * the assistant's call order, matching the context owned by the Rust engine. */
export class NativeHistoryToolBatch {
  private order: string[] = [];
  private readonly results = new Map<string, NativeHistoryToolResult>();
  private bytes = 0;

  stage(message: AgentMessage): void {
    if (this.order.length) throw new Error('Native history has an unsettled tool batch');
    const ids = message.content.flatMap(block => block.type === 'tool_use' ? [block.id] : []);
    if (ids.length > 256 || new Set(ids).size !== ids.length) throw new Error('Native history tool batch is invalid');
    this.order = ids;
  }

  accept(result: NativeHistoryToolResult): NativeHistoryToolResult[] {
    if (!this.order.includes(result.id) || this.results.has(result.id)) throw new Error('Native history has a foreign or duplicate tool result');
    this.bytes += Buffer.byteLength(result.result.content) + (result.result.extraUserMessageHex?.length ?? 0);
    if (this.bytes > 64 * 1024 * 1024) throw new Error('Native history tool batch exceeds byte bound');
    this.results.set(result.id, result);
    return this.results.size === this.order.length ? this.drain() : [];
  }

  /** A read snapshot may end mid-batch; expose only committed results in order. */
  snapshot(): NativeHistoryToolResult[] {
    return this.order.flatMap(id => this.results.has(id) ? [this.results.get(id)!] : []);
  }

  drain(): NativeHistoryToolResult[] {
    const values = this.snapshot();
    this.order = []; this.results.clear(); this.bytes = 0;
    return values;
  }
}

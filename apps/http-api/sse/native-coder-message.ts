import type { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage, ChatUsage, ContentBlock, ToolUseBlock } from '@mcp/provider-sdk/wire.js';
import { publish, type CoderRunBus } from '../coder-bus.js';

type PendingBlock = ToolUseBlock | { type: 'text' | 'thinking'; chunks: string[] };

/** Bounded, rebuildable provider-message projection. Usage snapshots replace
 * one another within a turn and are published once at its durable boundary. */
export class NativeCoderMessageProjection {
  private operation?: string;
  private blocks: PendingBlock[] = [];
  private bytes = 0;
  private usage?: ChatUsage;
  private completed = true;
  private readonly totals: ChatUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  private readonly emit: (event: string, data: unknown) => void;
  constructor(bus: CoderRunBus | ((event: string, data: unknown) => void)) {
    this.emit = typeof bus === 'function' ? bus : (event, data) => publish(bus, event, data);
  }

  get totalUsage(): ChatUsage { return { ...this.totals }; }

  start(operationId: string): void {
    if (!operationId || !this.completed) throw new Error('native provider started before the previous message boundary');
    this.operation = operationId; this.blocks = []; this.bytes = 0; this.usage = undefined; this.completed = false;
  }

  text(operationId: string, text: string, thinking: boolean): void {
    this.assertCurrent(operationId);
    this.reserve(Buffer.byteLength(text));
    const type = thinking ? 'thinking' : 'text';
    const last = this.blocks.at(-1);
    if (last?.type === type) last.chunks.push(text);
    else this.blocks.push({ type, chunks: [text] });
  }

  tool(operationId: string, tool: ToolUseBlock): void {
    this.assertCurrent(operationId); this.reserve(Buffer.byteLength(JSON.stringify(tool)));
    this.blocks.push(tool);
  }

  setUsage(operationId: string, usage: wire.EngineUsageSnapshotV1 | undefined): void {
    this.assertCurrent(operationId);
    if (!usage) throw new Error('native provider usage snapshot is absent');
    const count = (value: bigint) => {
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('native usage exceeds the presentation range');
      return Number(value);
    };
    this.usage = { input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens),
      cache_read_input_tokens: count(usage.cachedInputTokens) };
  }

  finish(phase: AgentMessage['phase'], operationId?: string, omitEmpty = false): void {
    if (operationId !== undefined && operationId !== this.operation) throw new Error('native provider completion belongs to another operation');
    if (this.completed) return;
    this.completed = true;
    if (this.usage) {
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens'] as const) {
        const total = (this.totals[key] ?? 0) + (this.usage[key] ?? 0);
        if (!Number.isSafeInteger(total)) throw new Error('native total usage exceeds the presentation range');
        this.totals[key] = total;
      }
    }
    const content: ContentBlock[] = this.blocks.map(block => block.type === 'tool_use'
      ? block : { type: block.type, text: block.chunks.join('') });
    if (!omitEmpty || content.length || this.usage) {
      this.emit('message_complete', { message: { role: 'assistant', content, phase }, usage: this.usage,
        native_provider_operation_id: this.operation });
    }
    this.blocks = []; this.bytes = 0;
  }

  private assertCurrent(operationId: string): void {
    if (this.completed || operationId !== this.operation) throw new Error('native content has no active provider operation');
  }
  private reserve(bytes: number): void {
    if (this.bytes + bytes > 16 * 1024 * 1024 || this.blocks.length >= 8_192) throw new Error('native message projection exceeds its bound');
    this.bytes += bytes;
  }
}

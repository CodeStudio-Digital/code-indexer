import { recordMemoTool } from '@mcp/code-agent/tools/record-memo.js';
import { MAX_MEMO_CHARS, type SubagentCollector, type SubagentMemoKind } from '@mcp/code-agent/tools/subagent-collector.js';
import { err, ok, type CoderTool } from '@mcp/code-agent/core/tool.js';
import type { BufferedEvent } from '../coder-bus.js';

/** Native memos are result data. The collector observes only the committed
 * journal event, so an unacknowledged invocation cannot publish a memo. */
export class NativeChildMemo {
  private reserved = 0;
  private readonly accepted = new Set<string>();
  readonly tool: CoderTool;
  constructor(private readonly collector: SubagentCollector) {
    this.tool = { ...recordMemoTool, effectBoundary: undefined, riskLevel: 'read', executionClass: 'read',
      handler: async (args, context) => {
        context.signal?.throwIfAborted();
        if (context.runtimeGeneration !== 'rust_v1' || context.subagentCollector !== collector) return err('Native memo has no owned child collector');
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text || text.length > MAX_MEMO_CHARS) return err('record_memo requires non-empty text of at most 300 characters');
        const kind: SubagentMemoKind = args.kind === 'decision' || args.kind === 'warning' || args.kind === 'progress' ? args.kind : 'observation';
        if (this.reserved >= 50) return ok('memo dropped (per-run cap reached).');
        this.reserved++;
        return { ...ok(`memo recorded [${kind}]: "${text.slice(0, 80)}"`), structuredData: { kind: 'native_child_memo', version: 1, text, memoKind: kind } };
      } };
  }
  accept(event: BufferedEvent) {
    if (event.event !== 'tool_call_result') return;
    const data = event.data as { id?: string; name?: string; result?: { isError?: boolean; structuredData?: unknown } };
    if (data?.name !== 'record_memo' || !data.id || data.result?.isError || this.accepted.has(data.id)) return;
    const value = data.result?.structuredData as { kind?: string; version?: number; text?: unknown; memoKind?: unknown } | undefined;
    if (value?.kind !== 'native_child_memo' || value.version !== 1 || typeof value.text !== 'string'
      || !value.text.trim() || value.text.length > MAX_MEMO_CHARS
      || !['observation', 'decision', 'warning', 'progress'].includes(String(value.memoKind))) throw new Error('Invalid committed native memo');
    if (this.accepted.size >= 50) return;
    this.accepted.add(data.id); this.collector.recordMemo(value.text, value.memoKind as SubagentMemoKind);
  }
}

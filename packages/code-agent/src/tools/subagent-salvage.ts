import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { SubagentCollected } from './subagent-collected.js';
import { consumeStream } from '@mcp/code-agent/core/runner/nodes/executing-stream.js';

export interface SalvageSummaryArgs {
  provider: ChatProvider;
  label?: string;
  reason: string;
  messages: AgentMessage[];
  toolCallCount: number;
  lastToolName?: string;
  collected: SubagentCollected;
  sandboxViolations: string[];
  parentSignal?: AbortSignal;
  timeoutMs?: number;
}

export async function buildSubagentSalvageSummary(args: SalvageSummaryArgs): Promise<{
  text: string;
  usage: ChatUsage;
}> {
  const deterministic = deterministicSummary(args);
  if (args.parentSignal?.aborted) return { text: deterministic, usage: zeroUsage() };

  const abort = new AbortController();
  const timeoutMs = Number.isFinite(args.timeoutMs) && (args.timeoutMs ?? 0) > 0
    ? Math.floor(args.timeoutMs!)
    : 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const consumePromise = consumeStream({
      stream: args.provider.chat({
        system:
          'You summarize a subagent run that was forcibly stopped. ' +
          'Return a concise operational summary for the parent agent. Do not call tools.',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: buildPrompt(args) }],
        }],
        tools: [],
        signal: abort.signal,
      }),
      signal: abort.signal,
      idleTimeoutMs: timeoutMs,
      thinkingOnlyTimeoutMs: timeoutMs,
    });
    consumePromise.catch(() => undefined);
    const result = await Promise.race([
      consumePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { abort.abort(new Error('salvage summary timeout')); } catch { /* ignore */ }
          reject(new Error('salvage summary timeout'));
        }, timeoutMs);
      }),
    ]);
    const text = result.textBlocks.join('\n').trim();
    return {
      text: text || deterministic,
      usage: result.usage ?? zeroUsage(),
    };
  } catch {
    return { text: deterministic, usage: zeroUsage() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildPrompt(args: SalvageSummaryArgs): string {
  return [
    `Subagent label: ${args.label ?? 'subagent'}`,
    `Stop reason: ${args.reason}`,
    `Tool calls: ${args.toolCallCount}`,
    `Last tool: ${args.lastToolName ?? 'none'}`,
    `Sandbox warnings: ${args.sandboxViolations.slice(0, 10).join(', ') || 'none'}`,
    `Collected memos: ${args.collected.memos.length}`,
    `Collected snapshots: ${args.collected.snapshots.length}`,
    `Collected board posts: ${args.collected.boardPosts.length}`,
    '',
    'Recent transcript:',
    serializeRecentMessages(args.messages, 8),
  ].join('\n');
}

function deterministicSummary(args: SalvageSummaryArgs): string {
  return [
    `Subagent stopped before a normal final answer.`,
    `Reason: ${args.reason}`,
    `Tools completed: ${args.toolCallCount}`,
    `Last tool: ${args.lastToolName ?? 'none'}`,
    `Collected: ${args.collected.memos.length} memos, ` +
      `${args.collected.snapshots.length} snapshots, ${args.collected.boardPosts.length} board posts.`,
    args.sandboxViolations.length > 0
      ? `Sandbox warnings: ${args.sandboxViolations.slice(0, 5).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

function serializeRecentMessages(messages: AgentMessage[], count: number): string {
  return messages.slice(-count).map((message) => {
    const content = Array.isArray(message.content)
      ? message.content.map((block) => serializeBlock(block as unknown as Record<string, unknown>)).join('\n')
      : String(message.content);
    return `${message.role}: ${content}`.slice(0, 2_000);
  }).join('\n---\n');
}

function serializeBlock(block: Record<string, unknown>): string {
  if (block.type === 'text' || block.type === 'thinking') return String(block.text ?? '');
  if (block.type === 'tool_use') return `[tool_use ${String(block.name ?? '')}]`;
  if (block.type === 'tool_result') return `[tool_result ${String(block.content ?? '').slice(0, 500)}]`;
  return `[${String(block.type ?? 'block')}]`;
}

function zeroUsage(): ChatUsage {
  return { input_tokens: 0, output_tokens: 0 };
}

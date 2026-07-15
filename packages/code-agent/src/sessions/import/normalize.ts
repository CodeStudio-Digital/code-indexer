import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { ExternalSessionMessage, ExternalSessionStats, ExternalSessionWarning } from './types.js';

const TOOL_RESULT_MAX_CHARS = 1_000_000;
const INLINE_BINARY_MAX_BYTES = 20 * 1024 * 1024;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function safeInput(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)) ?? { value }; } catch { return { value }; }
  }
  return { value };
}

export function boundedToolResult(content: string): Pick<Extract<ContentBlock, { type: 'tool_result' }>, 'content' | 'truncated' | 'originalSize'> {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return { content };
  return {
    content: `${content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[Imported tool result truncated; original size: ${content.length} characters]`,
    truncated: true,
    originalSize: content.length,
  };
}

export function boundedBase64(base64: string): { base64?: string; warning?: string } {
  const bytes = Math.ceil(base64.length * 0.75);
  if (bytes <= INLINE_BINARY_MAX_BYTES) return { base64 };
  return { warning: `[Imported binary attachment omitted; original size: ${bytes} bytes]` };
}

function auditText(text: string): ContentBlock {
  return { type: 'text', text: `[Import audit] ${text}` };
}

export function repairToolPairs(input: ExternalSessionMessage[]): {
  messages: ExternalSessionMessage[];
  warnings: ExternalSessionWarning[];
} {
  const uses = new Map<string, { name: string; count: number }>();
  const results = new Map<string, number>();
  for (const entry of input) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') {
        const seen = uses.get(block.id);
        uses.set(block.id, { name: block.name, count: (seen?.count ?? 0) + 1 });
      } else if (block.type === 'tool_result') {
        results.set(block.tool_use_id, (results.get(block.tool_use_id) ?? 0) + 1);
      }
    }
  }

  let incompleteUses = 0;
  let orphanResults = 0;
  const resultSeen = new Map<string, number>();
  const messages = input.map((entry): ExternalSessionMessage => {
    let forceAssistant = false;
    const content = entry.message.content.map((block): ContentBlock => {
      if (block.type === 'tool_use' && !results.has(block.id)) {
        incompleteUses += 1;
        return auditText(`tool call "${block.name}" (${block.id}) has no result in the source snapshot.`);
      }
      if (block.type === 'tool_result') {
        const seen = (resultSeen.get(block.tool_use_id) ?? 0) + 1;
        resultSeen.set(block.tool_use_id, seen);
        if (!uses.has(block.tool_use_id) || seen > 1) {
          orphanResults += 1;
          forceAssistant = true;
          return auditText(`unpaired tool result (${block.tool_use_id}): ${block.content}`);
        }
      }
      return block;
    });
    return {
      created_at: entry.created_at,
      message: { ...entry.message, role: forceAssistant ? 'assistant' : entry.message.role, content },
    };
  }).filter((entry) => entry.message.content.length > 0);

  const warnings: ExternalSessionWarning[] = [];
  if (incompleteUses) warnings.push({
    code: 'incomplete_tool_calls', message: `${incompleteUses} incomplete tool call(s) were converted to audit text`, count: incompleteUses,
  });
  if (orphanResults) warnings.push({
    code: 'orphan_tool_results', message: `${orphanResults} unpaired tool result(s) were converted to audit text`, count: orphanResults,
  });
  return { messages, warnings };
}

export function transcriptStats(messages: ExternalSessionMessage[]): ExternalSessionStats {
  let user = 0; let assistant = 0; let calls = 0; let results = 0;
  for (const entry of messages) {
    if (entry.message.role === 'user') user += 1;
    if (entry.message.role === 'assistant') assistant += 1;
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') calls += 1;
      if (block.type === 'tool_result') results += 1;
    }
  }
  return {
    message_count: messages.length,
    user_count: user,
    assistant_count: assistant,
    tool_call_count: calls,
    tool_result_count: results,
  };
}

export function meaningfulMessage(message: AgentMessage): boolean {
  return message.content.some((block) => block.type !== 'thinking' && (
    block.type !== 'text' || block.text.trim().length > 0
  ));
}

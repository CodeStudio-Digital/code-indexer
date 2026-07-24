/**
 * Normalized message types for the coder agent.
 *
 * The canonical definitions now live in `@mcp/provider-sdk` (so the provider
 * contract can reference them without depending back into code-agent). They
 * are re-exported here verbatim, so every existing
 * `@mcp/code-agent/core/messages.js` importer keeps working unchanged. The
 * helper functions below stay here — only the types moved.
 */

export type {
  AgentRole,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  DocumentBlock,
  QuestionBlock,
  PlanBlock,
  SpecBlock,
  ThinkingBlock,
  ContentBlock,
  AgentMessage,
  ChatUsage,
  ChatProviderResponseMeta,
  ChatDelta,
} from '@mcp/provider-sdk';

import type { ContentBlock, ChatUsage } from '@mcp/provider-sdk';

/**
 * Build a user-message content array from a text + optional attachments.
 * Images go through as ImageBlock; everything else as DocumentBlock — same
 * routing the providers expect.
 *
 * Used everywhere a human message can carry attachments: the initial
 * runCoder fresh-start, MasterLifecycle.sendUserMessage, and the master
 * tools that forward content to subordinates.
 */
export function attachmentsToBlocks(
  text: string,
  attachments?: ReadonlyArray<{
    name?: string;
    mediaType: string;
    path?: string;
    base64?: string;
    text?: string;
  }>,
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const att of attachments ?? []) {
    if (att.mediaType.startsWith('image/') && att.base64) {
      blocks.push({ type: 'image', mediaType: att.mediaType, base64: att.base64 });
    } else {
      blocks.push({
        type: 'document',
        name: att.name ?? 'attachment',
        mediaType: att.mediaType,
        path: att.path,
        text: att.text,
        base64: att.base64,
      });
    }
  }
  return blocks;
}

/**
 * True prompt size of a call. Prefers the adapter-normalized
 * `prompt_tokens_total`; falls back to raw `input_tokens`, which never
 * OVERcounts (it may undercount for additive-style providers that predate
 * the field — same behaviour as before the field existed). Returns null
 * when usage is absent or zeroed so callers can fall back to an estimate.
 */
export function promptTokensTotal(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  if (usage.prompt_tokens_total != null && usage.prompt_tokens_total > 0) {
    return usage.prompt_tokens_total;
  }
  return usage.input_tokens > 0 ? usage.input_tokens : null;
}

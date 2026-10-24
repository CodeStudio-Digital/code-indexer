import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage } from '@mcp/provider-sdk/wire.js';

export function applyPreparedUserContext(start: wire.ProviderStart, messages: AgentMessage[],
  contentBlocks: number, maximumBlocks: number, reserve: (bytes: number) => void): void {
  validatePreparedUserContext(start.preparedUserContext, start.messages);
  if (!start.preparedUserContext) return;
  if (contentBlocks + 1 > maximumBlocks) throw new Error('Prepared user context exceeds block budget');
  const context = start.preparedUserContext;
  reserve(Buffer.byteLength(context.contentUtf8));
  messages[context.messageIndex]!.content.push({ type: 'text', text: context.contentUtf8 });
}

/** Bounds/provenance for instructions pinned to one user message. The visible
 * conversation stays unchanged; the provider adapter applies this separately. */
export function validatePreparedUserContext(context: wire.ProviderPreparedUserContextV1 | undefined,
  messages: readonly wire.ProviderMessage[]): void {
  if (!context) return;
  const message = messages[context.messageIndex];
  const ids = context.selectedSkillIds;
  if (!Number.isSafeInteger(context.messageIndex) || context.messageIndex < 0
    || message?.role !== wire.ProviderMessageRole.USER || message.isMeta
    || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length
    || ids.some(id => !id || Buffer.byteLength(id) > 128 || /[\u0000-\u001f]/.test(id))
    || !context.contentUtf8 || Buffer.byteLength(context.contentUtf8) > 128 * 1024) {
    throw new Error('Prepared user context is invalid');
  }
}

import { createHash } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { AgentMessage } from '@mcp/provider-sdk/wire.js';

export function boundaryMessageDigest(message: wire.ProviderMessage): Uint8Array {
  return createHash('sha256').update(toBinary(wire.ProviderMessageSchema, message)).digest();
}

export function validatePreparedBoundaryContext(context: wire.ProviderPreparedBoundaryContextV1 | undefined,
  messages: readonly wire.ProviderMessage[]): void {
  if (!context) return;
  const message = messages[context.messageIndex];
  if (!Number.isSafeInteger(context.messageIndex) || context.messageIndex < 0
    || message?.role !== wire.ProviderMessageRole.USER || message.isMeta
    || context.sourceMessageSha256.length !== 32
    || !Buffer.from(context.sourceMessageSha256).equals(boundaryMessageDigest(message))
    || !context.contentUtf8 || Buffer.byteLength(context.contentUtf8) > 32 * 1024) {
    throw new Error('Prepared boundary context is invalid or belongs to a different user message');
  }
}

export function applyPreparedBoundaryContext(start: wire.ProviderStart, messages: AgentMessage[],
  contentBlocks: number, maximumBlocks: number, reserve: (bytes: number) => void): void {
  validatePreparedBoundaryContext(start.preparedBoundaryContext, start.messages);
  const context = start.preparedBoundaryContext;
  if (!context) return;
  if (contentBlocks + 1 + Number(!!start.preparedUserContext) > maximumBlocks) {
    throw new Error('Prepared boundary context exceeds block budget');
  }
  reserve(Buffer.byteLength(context.contentUtf8));
  messages[context.messageIndex]!.content.push({ type: 'text', text: context.contentUtf8 });
}

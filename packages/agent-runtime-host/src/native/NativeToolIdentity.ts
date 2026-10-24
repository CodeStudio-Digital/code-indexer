import { createHash } from 'node:crypto';

/** Provider IDs may repeat in another response. Product cards, approvals and
 * handler callbacks require a stable identity across the entire attempt. */
export function nativeToolUseId(attemptId: string, providerOperationId: string, toolUseId: string): string {
  if ([attemptId, providerOperationId, toolUseId].some(value => !value || value.length > 1_024)) {
    throw new Error('Native tool identity is invalid');
  }
  return `native-tool:${createHash('sha256').update(JSON.stringify([attemptId, providerOperationId, toolUseId])).digest('hex')}`;
}

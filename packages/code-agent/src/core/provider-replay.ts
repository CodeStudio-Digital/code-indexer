import { createHash } from 'node:crypto';
import type { AgentMessage, ProviderReplayState } from './messages.js';

/** Context reduction must never resurrect removed text or calls through an opaque replay. */
function messageDigest(message: AgentMessage): string {
  return createHash('sha256').update(JSON.stringify({
    role: message.role,
    phase: message.phase,
    content: message.content.filter((block) => block.type !== 'thinking'),
  })).digest('hex');
}

export function bindProviderReplay(message: AgentMessage, state: ProviderReplayState): void {
  // A backend may omit some final items. Replaying an incomplete output would
  // erase assistant context or leave tool results without their original call.
  const text = state.items.filter((item) => item.type === 'message').flatMap((item) =>
    Array.isArray(item.content) ? item.content as { type?: string; text?: string }[] : [])
    .filter((block) => block.type === 'output_text').map((block) => block.text ?? '').join('');
  const calls = state.items.filter((item) => item.type === 'function_call' || item.type === 'custom_tool_call')
    .map((item) => {
      let input: unknown;
      if (item.type === 'custom_tool_call') input = { _raw: item.input };
      else {
        try { input = JSON.parse(String(item.arguments)); } catch { input = { _raw: item.arguments }; }
      }
      return { type: 'tool_use', id: item.call_id, name: item.name, input };
    });
  const canonicalText = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const canonicalCalls = message.content.filter((block) => block.type === 'tool_use');
  if (text !== canonicalText || JSON.stringify(calls) !== JSON.stringify(canonicalCalls)
    || message.content.some((block) => !['text', 'thinking', 'tool_use'].includes(block.type))) return;
  message.providerReplay = { ...state, messageDigest: messageDigest(message) };
}

export function providerReplayItems(message: AgentMessage, scope: string): Record<string, unknown>[] | null {
  const state = message.providerReplay;
  if (message.role !== 'assistant' || state?.format !== 'openai-responses-v1'
    || state.scope !== scope || !Array.isArray(state.items)
    || state.messageDigest !== messageDigest(message)) return null;
  return state.items;
}

/** A bounded, complete output only. Failed streams and server-managed tools aren't replayed. */
export function responsesReplayState(scope: string, output: unknown): ProviderReplayState | null {
  if (!Array.isArray(output) || output.length === 0 || output.length > 512) return null;
  const allowed = new Set(['reasoning', 'message', 'function_call', 'custom_tool_call']);
  if (!output.every((item) => item && typeof item === 'object' && allowed.has(item.type))) return null;
  // Even zero-reasoning responses need their original item IDs for incremental
  // continuation. A reasoning item, when present, must carry its stateless payload.
  if (output.some((item) => item.type === 'reasoning'
    && (typeof item.encrypted_content !== 'string' || !item.encrypted_content))) return null;
  const encoded = JSON.stringify(output);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) return null;
  return { format: 'openai-responses-v1', scope, items: JSON.parse(encoded) as Record<string, unknown>[] };
}

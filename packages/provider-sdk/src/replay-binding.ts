import { createHash } from 'node:crypto';
import type { AgentMessage, ContentBlock, ProviderReplayState } from './wire.js';

export const verifiedReplayBinding = Symbol.for('codestudio.verified-replay-binding');
type StoredReplay = ProviderReplayState & { [verifiedReplayBinding]?: string | null };
type ReplayMessage = Pick<AgentMessage, 'role' | 'phase' | 'content'>;
const hash = (json: string) => createHash('sha256').update(json).digest('hex');
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const object = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
}
function visible(message: ReplayMessage) {
  return { role: message.role, phase: message.phase, content: message.content.filter(b => b.type !== 'thinking') };
}
export const replayMessageDigest = (message: ReplayMessage) => 'v2:' + hash(stableJson(visible(message)));

/** Recover the old order-sensitive hash from the provider's original argument string.
 * Both the old signed bytes and the complete visible message must agree before a binding is issued. */
export function verifyLegacyReplay(message: ReplayMessage, state: ProviderReplayState): string | null {
  if (!state.messageDigest || !/^[0-9a-f]{64}$/.test(state.messageDigest)) return null;
  const current = visible(message);
  if (hash(JSON.stringify(current)) === state.messageDigest) return replayMessageDigest(message);
  if (!Array.isArray(state.items)) return null;
  const calls = new Map(state.items.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call')
    .map(item => [item.call_id, item]));
  const content: ContentBlock[] = [];
  for (const block of current.content) {
    if (block.type === 'text') { content.push({ type: 'text', text: block.text }); continue; }
    if (block.type !== 'tool_use') return null;
    const item = calls.get(block.id);
    if (!item || item.name !== block.name) return null;
    let input: unknown = { _raw: item.input };
    if (item.type === 'function_call') {
      try { input = JSON.parse(String(item.arguments)); } catch { input = { _raw: item.arguments }; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    content.push({ type: 'tool_use', id: block.id, name: block.name, input: input as Record<string, unknown> });
  }
  const rebuilt = { ...current, content };
  return hash(JSON.stringify(rebuilt)) === state.messageDigest && stableJson(current) === stableJson(rebuilt)
    ? replayMessageDigest(message) : null;
}

export function matchesReplayMessage(message: ReplayMessage, state: StoredReplay): boolean {
  if (state.messageDigest?.startsWith('v2:')) return replayMessageDigest(message) === state.messageDigest;
  if (verifiedReplayBinding in state) {
    return !!state[verifiedReplayBinding] && replayMessageDigest(message) === state[verifiedReplayBinding];
  }
  return verifyLegacyReplay(message, state) !== null;
}

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { storedProviderReplay } from '@mcp/provider-sdk';
import { verifiedReplayBinding, verifyLegacyReplay } from '@mcp/provider-sdk/replay-binding.js';
import type { AgentMessage } from '../messages.js';
import { bindProviderReplay, providerReplayItems, responsesReplayState } from '../provider-replay.js';
import { toResponsesInput } from '../../providers/chatgpt.js';

const output = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-fixture', summary: [] },
  { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] },
  { type: 'custom_tool_call', id: 'ct_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
];
function message(): AgentMessage {
  return { role: 'assistant', phase: 'commentary', content: [
    { type: 'thinking', text: 'Public summary' }, { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'call_1', name: 'apply_patch', input: { _raw: output[2].input } },
  ] };
}

describe('opaque Responses continuation', () => {
  it('replays encrypted reasoning, phases and custom calls in their original order', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('account:model', output)!);
    expect(toResponsesInput([m], 'account:model')).toEqual(output);
    expect(toResponsesInput([m, { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'applied' }] }], 'account:model').at(-1))
      .toEqual({ type: 'custom_tool_call_output', call_id: 'call_1', output: 'applied' });
    expect(toResponsesInput([m])).not.toEqual(output);
  });

  it('does not reuse state across accounts/models or after context reduction', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('account:model', output)!);
    expect(providerReplayItems(m, 'other-account:model')).toBeNull();
    expect(providerReplayItems(m, 'account:other-model')).toBeNull();
    m.content = m.content.filter((block) => block.type !== 'tool_use');
    expect(providerReplayItems(m, 'account:model')).toBeNull();
    expect(toResponsesInput([m], 'account:model').some((item) => 'call_id' in item)).toBe(false);
  });

  it('keeps replay when only the readable reasoning summary is stripped', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('s', output)!);
    m.content = m.content.filter((block) => block.type !== 'thinking');
    expect(providerReplayItems(m, 's')).toEqual(output);
  });

  it('reopens old sorted JSON without reading opaque items for a different account, a shortened message or edited arguments', () => {
    const input = { z: 1, a: 2 };
    const original: AgentMessage = { role: 'assistant', phase: 'commentary',
      content: [{ type: 'tool_use', id: 'call', name: 'read', input }] };
    const items = [{ type: 'function_call', call_id: 'call', name: 'read', arguments: JSON.stringify(input) }];
    const state = { format: 'openai-responses-v1' as const, scope: 'account:model', items,
      messageDigest: createHash('sha256').update(JSON.stringify({ role: original.role, phase: original.phase, content: original.content })).digest('hex') };
    const persisted: AgentMessage = { role: 'assistant', phase: 'commentary',
      content: [{ id: 'call', input: { a: 2, z: 1 }, name: 'read', type: 'tool_use' }] };
    const binding = verifyLegacyReplay(persisted, state);
    expect(binding).toMatch(/^v2:/);
    const read = vi.fn(() => items);
    persisted[storedProviderReplay] = Object.assign({ ...state, get items() { return read(); } }, { [verifiedReplayBinding]: binding });
    expect(providerReplayItems(persisted, 'other:model')).toBeNull();
    expect(providerReplayItems({ ...persisted, content: [] }, state.scope)).toBeNull();
    const edited: AgentMessage = { ...persisted, content: [{ type: 'tool_use', id: 'call', name: 'read', input: { z: 9, a: 2 } }] };
    expect(verifyLegacyReplay(edited, state)).toBeNull();
    expect(providerReplayItems(edited, state.scope)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(providerReplayItems(persisted, state.scope)).toEqual(items);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('retains item IDs when an easy turn does not need any reasoning tokens', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('s', output.slice(1))!);
    expect(providerReplayItems(m, 's')).toEqual(output.slice(1));
  });

  it('can continue from the visible message if its optional replay file is damaged', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('s', output)!);
    const read = vi.fn(() => { throw new Error('damaged sidecar'); });
    m[storedProviderReplay] = { ...m.providerReplay!, get items() { return read(); } };
    delete m.providerReplay;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const plain = toResponsesInput([m]);
      expect(toResponsesInput([m], 's')).toEqual(plain);
      expect(toResponsesInput([m], 's')).toEqual(plain);
      expect(read).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('rejects incomplete, unsupported and oversized outputs', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('s', output.slice(0, 2))!);
    expect(m.providerReplay).toBeUndefined();
    expect(responsesReplayState('s', [{ type: 'reasoning', summary: [] }])).toBeNull();
    expect(responsesReplayState('s', [...output, { type: 'image_generation_call' }])).toBeNull();
    expect(responsesReplayState('s', [{ ...output[0], encrypted_content: 'x'.repeat(2 * 1024 * 1024) }])).toBeNull();
  });
});

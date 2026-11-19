import { describe, expect, it } from 'vitest';
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

  it('retains item IDs when an easy turn does not need any reasoning tokens', () => {
    const m = message();
    bindProviderReplay(m, responsesReplayState('s', output.slice(1))!);
    expect(providerReplayItems(m, 's')).toEqual(output.slice(1));
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

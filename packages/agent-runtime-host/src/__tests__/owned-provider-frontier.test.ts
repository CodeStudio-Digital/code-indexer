import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import { OwnedProviderFrontierEncoder, encodeProviderFrontier, decodeProviderFrontier,
  type ProviderFrontier } from '../native/ProviderFrontierCodec.js';
import { identity } from './attempt-channel-support.js';
import { NATIVE_SESSION_PAYLOAD_BYTES } from '../native/NativeSessionStoreLimits.js';

describe('owned provider frontier projection', () => {
  it('rejects an oversized checkpoint record before handing it to the native writer', () => {
    expect(() => new OwnedProviderFrontierEncoder().encode(start('large', [message('x'.repeat(NATIVE_SESSION_PAYLOAD_BYTES))])))
      .toThrow('provider frontier byte limit');
  });
  it('keeps checkpoint bytes compatible across append, compaction, binding and attempt changes', () => {
    const encoder = new OwnedProviderFrontierEncoder();
    let previous: ProviderFrontier | undefined;
    let replayed: ProviderFrontier | undefined;
    let messages = [message('initial')];
    for (let index = 0; index < 40; index++) {
      if (index === 10) messages = [message('compacted summary')];
      else if (index > 0) messages = [...messages, message(`turn/${index}`)];
      const request = start(String(index), messages);
      request.binding!.effectiveModel = index >= 20 ? 'changed' : 'original';
      if (index >= 25) request.identity!.attemptId = '20000000-0000-4000-8000-000000000077';
      request.previousResponseId = `response/${index}`;
      request.previousResponseMessageCount = BigInt(messages.length);
      const full = index % 32 === 0;
      const expected = encodeProviderFrontier(request, full ? undefined : previous);
      const payload = encoder.encode(request, full);
      expect(payload).toEqual(expected.payload);
      replayed = decodeProviderFrontier(payload, replayed);
      expect(replayed).toEqual(expected.frontier);
      previous = expected.frontier;
    }
  });

  it('does not trust object identity when historical content or unknown bytes change', () => {
    const encoder = new OwnedProviderFrontierEncoder();
    const original = message('before');
    original.content[0]!.$unknown = [{ no: 100, wireType: 0, data: Uint8Array.of(1) }];
    const first = encoder.encode(start('one', [original]));
    original.content[0]!.$unknown![0]!.data[0] = 2;
    const changed = encoder.encode(start('two', [original, message('next')]));
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema, changed).baseOperationId).toBe('');
    expect(decodeProviderFrontier(first).value.context!.messages[0]!.content[0]!.$unknown![0]!.data[0]).toBe(1);
    const base = decodeProviderFrontier(changed);
    original.content = message('rewritten').content;
    const rewritten = encoder.encode(start('three', [original, message('next')]));
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema, rewritten).baseOperationId).toBe('');
    expect(decodeProviderFrontier(rewritten, base).value.context!.messages[0]).toEqual(original);
  });

  it('keeps its private base isolated from returned payloads and changed metadata', () => {
    const encoder = new OwnedProviderFrontierEncoder();
    const request = start('one', [message('before')]);
    request.messages[0]!.content[0]!.$unknown = [{ no: 100, wireType: 0, data: Uint8Array.of(1) }];
    const payload = encoder.encode(request);
    const first = decodeProviderFrontier(payload.slice());
    payload.fill(0);
    request.operationId = 'two';
    request.system = create(wire.ProviderTextContentSchema, { body: { case: 'inlineUtf8', value: 'new system' } });
    request.messages.push(message('after'));
    const secondPayload = encoder.encode(request);
    request.system.body = { case: 'inlineUtf8', value: 'mutated after encode' };
    request.messages[1]!.content = message('also mutated').content;
    const second = decodeProviderFrontier(secondPayload, first);
    expect(second.value.context!.system?.body).toEqual({ case: 'inlineUtf8', value: 'new system' });
    expect(second.value.context!.messages).toEqual([first.value.context!.messages[0], message('after')]);
    const third = start('three', [first.value.context!.messages[0]!, message('after'), message('last')]);
    const thirdPayload = encoder.encode(third);
    expect(fromBinary(wire.ProviderFrontierRecordV1Schema, thirdPayload).baseOperationId).toBe('two');
    expect(decodeProviderFrontier(thirdPayload, second).value.context!.messages).toEqual(third.messages);
  });
});

function start(operationId: string, messages: wire.ProviderMessage[]) {
  return create(wire.ProviderStartSchema, { identity: identity(), operationId, messages,
    binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' } });
}
function message(text: string) {
  return create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: text } } } }] });
}

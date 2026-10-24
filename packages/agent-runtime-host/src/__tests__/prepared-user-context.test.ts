import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { adaptProviderRequest } from '../provider-gateway/ProviderRequestAdapter.js';
import { DEFAULT_PROVIDER_GATEWAY_LIMITS } from '../provider-gateway/ProviderGatewayTypes.js';
import { encodeProviderFrontier, decodeProviderFrontier } from '../native/ProviderFrontierCodec.js';
import { identity } from './attempt-channel-support.js';

it('authenticates resolved instructions while keeping provider and transcript views separate', async () => {
  const request = create(wire.ProviderStartSchema, { identity: identity(), operationId: 'selected',
    binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' },
    messages: [{ role: wire.ProviderMessageRole.USER, content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'task' } } } }] }],
    preparedUserContext: { messageIndex: 0, selectedSkillIds: ['review'], contentUtf8: 'FROZEN_SKILL' } });
  const saved = encodeProviderFrontier(request);
  const restored = decodeProviderFrontier(saved.payload);
  expect(restored.value.context?.preparedUserContext?.contentUtf8).toBe('FROZEN_SKILL');
  const provider = await adaptProviderRequest(request, undefined, DEFAULT_PROVIDER_GATEWAY_LIMITS, new AbortController().signal);
  expect(provider.system).toBe('');
  expect(provider.messages[0]?.content).toEqual([{ type: 'text', text: 'task' }, { type: 'text', text: 'FROZEN_SKILL' }]);
  const visible = await adaptProviderRequest(create(wire.ProviderStartSchema, { messages: request.messages }),
    undefined, DEFAULT_PROVIDER_GATEWAY_LIMITS, new AbortController().signal);
  expect(visible.messages[0]?.content).toEqual([{ type: 'text', text: 'task' }]);
  const corrupt = fromBinary(wire.ProviderFrontierRecordV1Schema, saved.payload);
  corrupt.frontier!.context!.preparedUserContext!.contentUtf8 = 'changed';
  expect(() => decodeProviderFrontier(toBinary(wire.ProviderFrontierRecordV1Schema, corrupt))).toThrow('digest');
  request.preparedUserContext!.messageIndex = 1;
  await expect(adaptProviderRequest(request, undefined, DEFAULT_PROVIDER_GATEWAY_LIMITS, new AbortController().signal)).rejects.toThrow('invalid');
});

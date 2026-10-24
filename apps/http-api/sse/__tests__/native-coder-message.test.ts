import { create } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { createBus } from '../../coder-bus.js';
import { NativeCoderMessageProjection } from '../native-coder-message.js';

it('publishes one message and the latest usage snapshot at each provider boundary', () => {
  const bus = createBus(new AbortController());
  const projection = new NativeCoderMessageProjection(bus);
  projection.start('provider:1');
  projection.text('provider:1', 'Checking', true);
  projection.text('provider:1', 'Read ', false);
  projection.text('provider:1', 'files', false);
  projection.tool('provider:1', { type: 'tool_use', id: 'remote:1', name: 'read_file', input: { path: 'a' } });
  projection.setUsage('provider:1', create(wire.EngineUsageSnapshotV1Schema, { inputTokens: 5n, outputTokens: 2n }));
  projection.setUsage('provider:1', create(wire.EngineUsageSnapshotV1Schema, { inputTokens: 6n, outputTokens: 3n, cachedInputTokens: 1n }));
  expect(bus.buffer).toHaveLength(0);
  projection.finish('commentary');
  projection.finish('commentary');
  expect(bus.buffer).toHaveLength(1);
  expect(bus.buffer[0]).toMatchObject({ event: 'message_complete', data: {
    message: { role: 'assistant', phase: 'commentary', content: [
      { type: 'thinking', text: 'Checking' }, { type: 'text', text: 'Read files' },
      { type: 'tool_use', id: 'remote:1', name: 'read_file', input: { path: 'a' } },
    ] }, usage: { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 1 },
  } });
  projection.start('provider:2');
  projection.text('provider:2', 'Finished', false);
  projection.finish('final_answer', 'provider:2');
  expect(bus.buffer[1]).toMatchObject({ data: { message: { phase: 'final_answer', content: [{ type: 'text', text: 'Finished' }] }, usage: undefined } });
  expect(projection.totalUsage).toEqual({ input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 1 });
  projection.start('provider:3');
  projection.setUsage('provider:3', create(wire.EngineUsageSnapshotV1Schema, { inputTokens: 4n, outputTokens: 2n }));
  projection.finish('final_answer', 'provider:3');
  projection.finish('final_answer', 'provider:3');
  expect(projection.totalUsage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 });
});

it('rejects overlapping turns, foreign content, late usage and oversized messages', () => {
  const projection = new NativeCoderMessageProjection(createBus(new AbortController()));
  projection.start('provider:1');
  expect(() => projection.start('provider:2')).toThrow('previous message');
  expect(() => projection.text('foreign', 'wrong', false)).toThrow('active provider');
  expect(() => projection.finish('final_answer', 'foreign')).toThrow('another operation');
  expect(() => projection.text('provider:1', 'x'.repeat(16 * 1024 * 1024 + 1), false)).toThrow('bound');
  expect(() => projection.setUsage('provider:1', create(wire.EngineUsageSnapshotV1Schema, { inputTokens: 2n ** 63n }))).toThrow('presentation range');
  projection.finish('commentary');
  expect(() => projection.setUsage('provider:1', create(wire.EngineUsageSnapshotV1Schema))).toThrow('active provider');
});

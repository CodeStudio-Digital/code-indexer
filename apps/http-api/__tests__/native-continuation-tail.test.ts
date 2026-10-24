import { createHash, randomUUID } from 'node:crypto';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { expect, it } from 'vitest';
import { NativeContinuationTail } from '../workers/native-continuation-tail.js';

function record(body: MessageInitShape<typeof journal.EngineEventRecordV1Schema>['body']) {
  return create(journal.EngineEventRecordV1Schema, { body });
}
function text(value: string, thinking = false, operationId = 'op') {
  const bytes = Buffer.from(value);
  return record({ case: 'content', value: { kind: journal.EngineContentKindV1.TRANSCRIPT,
    contentId: randomUUID(), operationId, contentSchemaId: 'text/utf8', contentSchemaVersion: 1,
    encodedChunk: bytes, totalBytes: BigInt(bytes.length), contentSha256: createHash('sha256').update(bytes).digest(), thinking } });
}
const started = () => record({ case: 'providerStarted', value: { operationId: 'op' } });
const stopped = () => record({ case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.INTERRUPTED } });

it.each([false, true])('retains committed partial text/thinking in projection order, checkpoint first=%s', first => {
  const tail = new NativeContinuationTail();
  if (first) { tail.reset('op'); tail.accept(started()); }
  else { tail.accept(started()); tail.reset('op'); }
  tail.accept(text('reason', true)); tail.accept(text('a')); tail.accept(text('b'));
  expect(tail.messages()).toEqual([]);
  tail.accept(stopped());
  const [message] = tail.messages();
  expect(message?.role).toBe(wire.ProviderMessageRole.ASSISTANT);
  expect(message?.phase).toBe(wire.ProviderMessagePhase.COMMENTARY);
  expect(message?.content.map(b => [b.body.case, b.body.value && 'body' in b.body.value ? b.body.value.body : null]))
    .toEqual([['thinking', { case: 'inlineUtf8', value: 'reason' }], ['text', { case: 'inlineUtf8', value: 'ab' }]]);
  tail.reset('next'); expect(tail.messages()).toEqual([]);
});

it('does not synthesize a continuation across capability boundaries or a completed provider', () => {
  for (const body of [{ case: 'capabilityBoundary', value: {} }, { case: 'providerCompleted', value: {} }] as const) {
    const tail = new NativeContinuationTail(); tail.reset('op'); tail.accept(text('partial'));
    tail.accept(record(body)); tail.accept(stopped()); expect(tail.messages()).toEqual([]);
  }
});

it('preserves an empty billed assistant boundary but omits a provider that never opened', () => {
  const tail = new NativeContinuationTail(); tail.reset('op'); tail.accept(started()); tail.accept(stopped());
  expect(tail.messages()).toEqual([]);
  tail.reset('op'); tail.accept(started());
  tail.accept(record({ case: 'providerUsage', value: { operationId: 'op', usage: { inputTokens: 1n } } }));
  tail.accept(stopped());
  expect(tail.messages()).toHaveLength(1);
  expect(tail.messages()[0]?.content).toEqual([]);
});

it('requires content integrity, exact operation and complete chunk groups', () => {
  const tail = new NativeContinuationTail(); tail.reset('op');
  expect(() => tail.accept(text('foreign', false, 'other'))).toThrow(/different operation/);
  const corrupt = text('invalid');
  if (corrupt.body.case === 'content') corrupt.body.value.contentSha256[0] ^= 1;
  expect(() => tail.accept(corrupt)).toThrow(/hash/);
  const partial = text('whole');
  if (partial.body.case === 'content') partial.body.value.encodedChunk = partial.body.value.encodedChunk.slice(0, 2);
  tail.accept(partial);
  expect(() => tail.reset()).toThrow();
  expect(() => tail.accept(stopped())).toThrow();
});

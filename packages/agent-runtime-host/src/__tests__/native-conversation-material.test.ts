import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { createNativeConversationMaterial } from '../native/NativeConversationMaterial.js';
import type { AgentMessage } from '@mcp/provider-sdk/wire.js';

it('reuses exact attachment identities within a session while separating names, content and owners', async () => {
  const input = { sessionId: 'session', maximumBytes: 4096, messages: [{ role: 'user' as const, content: [
    { type: 'text' as const, text: 'task' },
    { type: 'document' as const, name: 'a.txt', mediaType: 'text/plain', text: 'same bytes' },
    { type: 'document' as const, name: 'a.txt', mediaType: 'text/plain', text: 'same bytes' },
  ] }] };
  const first = await createNativeConversationMaterial(input);
  const second = await createNativeConversationMaterial(input);
  const other = await createNativeConversationMaterial({ ...input, sessionId: 'other' });
  const renamed = await createNativeConversationMaterial({ ...input, messages: [{ role: 'user', content: [
    input.messages[0]!.content[0]!, { ...input.messages[0]!.content[1]!, type: 'document', name: 'b.txt', mediaType: 'text/plain', text: 'same bytes' },
  ] }] });
  try {
    expect(first.artifacts).toHaveLength(1);
    expect(first.task.attachments[0]).toEqual(first.task.attachments[1]);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(other.artifacts[0]!.artifactId).not.toBe(first.artifacts[0]!.artifactId);
    expect(renamed.artifacts[0]!.artifactId).not.toBe(first.artifacts[0]!.artifactId);
    expect(new TextDecoder().decode(await first.artifactReader.read(first.artifacts[0]!, 1024, new AbortController().signal))).toBe('same bytes');
  } finally { for (const material of [first, second, other, renamed]) material.close(); }
});

it('hydrates detached history and retains owned image bytes until the provider lifetime ends', async () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'earlier task' }] },
    { role: 'assistant', phase: 'final_answer', content: [{ type: 'thinking', text: 'earlier reasoning' }, { type: 'text', text: 'earlier answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', mediaType: 'image/png', base64: 'AQID' }] },
  ];
  const material = await createNativeConversationMaterial({ sessionId: 'session', messages, maximumBytes: 1024 });
  messages[0]!.content.length = 0;
  const item = material.source.items[0]!;
  const bytes = await material.source.readExact(0, 0n, Number(item.byteLength));
  const snapshot = fromBinary(wire.InitialConversationSnapshotV1Schema, bytes.slice());
  expect(snapshot.messages).toHaveLength(3);
  expect(snapshot.messages[0]?.content[0]?.body.case).toBe('text');
  expect(snapshot.messages[1]?.content[0]?.body.case).toBe('thinking');
  bytes.fill(0);
  const again = await material.source.readExact(0, 0n, Number(item.byteLength));
  expect(fromBinary(wire.InitialConversationSnapshotV1Schema, again)).toEqual(snapshot);
  const image = material.task.attachments[0]!;
  await material.source.close();
  expect(await material.artifactReader.read(image, 4, new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3]));
  const foreign = { ...image, ownerSessionId: 'foreign' };
  expect(() => material.artifactReader.read(foreign, 4, new AbortController().signal)).toThrow(/not owned/);
  material.close();
  expect(() => material.artifactReader.read(image, 4, new AbortController().signal)).toThrow(/closed/);
});

it('fails preparation before launch for unresolved tools, foreign content, oversized input and unapproved document reads', async () => {
  const task: AgentMessage = { role: 'user', content: [{ type: 'text', text: 'task' }] };
  await expect(createNativeConversationMaterial({ sessionId: 'session', maximumBytes: 1024,
    messages: [{ role: 'user', content: [{ type: 'thinking', text: 'invalid role' }] }, task] })).rejects.toThrow(/content/);
  await expect(createNativeConversationMaterial({ sessionId: 'session', maximumBytes: 1024,
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'write', input: {} }] }, task] }))
    .rejects.toThrow(/message order/);
  await expect(createNativeConversationMaterial({ sessionId: 'session', maximumBytes: 2, messages: [task] }))
    .rejects.toThrow(/byte budget/);
  await expect(createNativeConversationMaterial({ sessionId: 'session', maximumBytes: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'task' },
      { type: 'document', name: 'private', mediaType: 'text/plain', path: 'C:\\private' }] }] }))
    .rejects.toThrow(/authorized reader/);
  const reader = vi.fn();
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await expect(createNativeConversationMaterial({ sessionId: 'session', maximumBytes: 1024, messages: [task],
    readDocument: reader, signal: controller.signal })).rejects.toThrow('cancelled');
  expect(reader).not.toHaveBeenCalled();
});

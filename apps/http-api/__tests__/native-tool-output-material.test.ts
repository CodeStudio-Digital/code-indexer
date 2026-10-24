import { expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { decodeNativeToolUserMessage, encodeNativeToolUserMessage, type NativeRustHostAttemptRuntime } from '@mcp/agent-runtime-host';
import { NativeToolOutputMaterial } from '../workers/native-tool-output-material.js';

const image = { type: 'image' as const, mediaType: 'image/png', base64: Buffer.from('image bytes').toString('base64') };
it('publishes previews only after attachment commits and closes owned bytes', async () => {
  const material = new NativeToolOutputMaterial('session');
  let release!: () => void;
  const committed = new Promise<void>(resolve => { release = resolve; });
  const refs: Parameters<NonNullable<typeof material.artifactReader.read>>[0][] = [];
  const runtime = { commitAttachment: vi.fn<NativeRustHostAttemptRuntime['commitAttachment']>(async (ref, reader) => {
    refs.push(ref);
    expect(Buffer.from(await reader.read(ref, 100, new AbortController().signal)).toString()).toBe('image bytes');
    await committed;
  }) };
  const pending = material.commit([{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }],
    runtime, new AbortController().signal);
  await vi.waitFor(() => expect(runtime.commitAttachment).toHaveBeenCalledOnce());
  expect(material.hasArtifact(refs[0]!.artifactId)).toBe(false);
  release();
  const result = (await pending)!;
  expect(decodeNativeToolUserMessage(result.extraUserMessageHex).content.map(block => block.body.case))
    .toEqual(['text', 'attachment', 'text']);
  expect(material.resolvePreview(result.extraUserMessageHex)).toEqual([{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }]);
  expect(material.hasArtifact(refs[0]!.artifactId)).toBe(true);
  material.close();
  expect(() => material.resolvePreview(result.extraUserMessageHex)).toThrow('no committed material');
  expect(() => material.artifactReader.read(refs[0]!, 100, new AbortController().signal)).toThrow('not owned');
});

it('rejects uncommitted, oversized and foreign-role extra content', async () => {
  const material = new NativeToolOutputMaterial('session', 1024);
  await expect(material.commit([image], { commitAttachment: async () => { throw new Error('disk full'); } }, new AbortController().signal))
    .rejects.toThrow('disk full');
  await expect(material.commit([{ type: 'text', text: 'x'.repeat(1024) }], { commitAttachment: async () => {} }, new AbortController().signal))
    .rejects.toThrow('budget');
  expect(() => encodeNativeToolUserMessage(create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.ASSISTANT,
    content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: 'injected' } } } }] })))
    .toThrow('content');
  expect(() => decodeNativeToolUserMessage('zz')).toThrow('encoding');
  material.close();
});

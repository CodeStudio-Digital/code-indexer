import { create, fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '../../../packages/agent-runtime-contracts/src/index.js';
import { createNativeConversationMaterial, encodeNativeToolUserMessage,
  type NativeRustHostAttemptRuntime, type ProviderArtifactReaderPort } from '../../../packages/agent-runtime-host/src/index.js';
import type { ContentBlock } from '../../../packages/provider-sdk/src/wire.js';

/** Attempt-owned tool attachments. Durable chunks precede the result receipt;
 * live previews are released only when that receipt reaches the projection. */
export class NativeToolOutputMaterial {
  private readonly owners = new Map<string, Awaited<ReturnType<typeof createNativeConversationMaterial>>>();
  private readonly previews = new Map<string, readonly ContentBlock[]>();
  private used = 0;
  private closed = false;
  constructor(private readonly sessionId: string, private readonly maximumBytes = 8 * 1024 * 1024) {}

  readonly artifactReader: ProviderArtifactReaderPort = { read: (reference, maximumBytes, signal) => {
    const owner = this.owners.get(reference.artifactId);
    if (this.closed || !owner) throw new Error('Native tool artifact is not owned by this attempt');
    return owner.artifactReader.read(reference, maximumBytes, signal);
  } };

  hasArtifact(id: string): boolean { return this.owners.has(id); }

  resolvePreview(encoded: string): readonly ContentBlock[] {
    const blocks = this.previews.get(encoded);
    if (this.closed || !blocks) throw new Error('Native tool preview has no committed material');
    return blocks;
  }

  async commit(blocks: readonly ContentBlock[] | undefined, runtime: Pick<NativeRustHostAttemptRuntime, 'commitAttachment'>,
    signal: AbortSignal): Promise<void | { extraUserMessageHex: string }> {
    if (!blocks?.length) return;
    if (this.closed || blocks.length > 64 || this.previews.size >= 256
      || blocks.some(block => !['text', 'image', 'document'].includes(block.type)
        || (block.type === 'document' && block.path))) throw new Error('Unsupported native tool attachment');
    signal.throwIfAborted();
    const copied = structuredClone(blocks);
    // Material owns binary content; reconstruct the original order below.
    const material = await createNativeConversationMaterial({ sessionId: this.sessionId,
      maximumBytes: this.maximumBytes - this.used, signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: '' },
        ...copied.filter(block => block.type === 'image' || block.type === 'document')] }] });
    try {
      const item = material.source.items[0]!;
      const snapshot = fromBinary(wire.InitialConversationSnapshotV1Schema,
        await material.source.readExact(0, 0n, Number(item.byteLength), signal));
      const attachments = snapshot.messages[0]!.content.slice(1);
      let attachmentIndex = 0;
      const message = create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
        content: copied.map(block => block.type === 'text'
          ? create(wire.ProviderContentBlockSchema, { body: { case: 'text', value: { body: { case: 'inlineUtf8', value: block.text } } } })
          : attachments[attachmentIndex++]!) });
      const encoded = encodeNativeToolUserMessage(message);
      const bytes = encoded.length + material.artifacts.reduce((sum, ref) => sum + Number(ref.byteLength), 0);
      if (this.used + bytes > this.maximumBytes) throw new Error('Native tool attachments exceed the attempt budget');
      // Reserve before awaiting persistence: parallel reads share one budget.
      this.used += bytes;
      for (const reference of material.artifacts) await runtime.commitAttachment(reference, material.artifactReader, signal);
      signal.throwIfAborted();
      if (this.closed) throw new Error('Native tool material closed during commit');
      for (const reference of material.artifacts) {
        // Exact IDs deduplicate content, but each owner may contain multiple
        // references. Keep all successful owners until attempt cleanup.
        if (!this.owners.has(reference.artifactId)) this.owners.set(reference.artifactId, material);
      }
      this.previews.set(encoded, copied);
      await material.source.close();
      if (!material.artifacts.some(ref => this.owners.get(ref.artifactId) === material)) material.close();
      return { extraUserMessageHex: encoded };
    } catch (cause) { material.close(); throw cause; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const owner of new Set(this.owners.values())) owner.close();
    this.owners.clear(); this.previews.clear();
  }
}

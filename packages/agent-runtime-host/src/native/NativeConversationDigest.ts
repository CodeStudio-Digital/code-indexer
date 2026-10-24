import { createHash } from 'node:crypto';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { NativeConversationMaterialOptions } from './NativeConversationMaterial.js';
import { encodeNativeConversationMessage, readNativeConversationAttachment } from './NativeConversationMessage.js';

/** Hashes the exact protobuf transcript without allocating a full snapshot.
 * Repeated message fields concatenate identically to a single context encode. */
class ConversationDigest {
  private readonly hash = createHash('sha256');
  private readonly calls = new Map<string, string>();
  private ordinal = 0;
  private count = 0;
  private bytes = 0;

  add(message: wire.ProviderMessage) {
    if (++this.count > 100_000) throw new Error('Native continuation message limit');
    for (const block of message.content) {
      if (block.body.case === 'toolUse') {
        const id = block.body.value.toolUseId;
        if (this.calls.has(id)) throw new Error('Native continuation has duplicate unsettled tool calls');
        const canonical = `call:${++this.ordinal}`;
        this.calls.set(id, canonical); block.body.value.toolUseId = canonical;
      } else if (block.body.case === 'toolResult') {
        const id = block.body.value.toolUseId, canonical = this.calls.get(id);
        if (!canonical) throw new Error('Native continuation has an unmatched tool result');
        this.calls.delete(id); block.body.value.toolUseId = canonical;
      }
    }
    const encoded = toBinary(wire.ProviderTurnContextSchema, create(wire.ProviderTurnContextSchema, { messages: [message] }));
    try {
      this.bytes += encoded.length;
      if (this.bytes > 64 * 1024 * 1024) throw new Error('Native continuation transcript byte limit');
      this.hash.update(encoded);
    } finally { encoded.fill(0); }
  }

  finish() {
    if (!this.count || this.calls.size) throw new Error('Native continuation has empty history or unsettled tool calls');
    return this.hash.digest('hex');
  }
}

export function nativeConversationDigest(messages: readonly wire.ProviderMessage[]): string {
  const digest = new ConversationDigest();
  for (const message of messages) digest.add(clone(wire.ProviderMessageSchema, message));
  return digest.finish();
}

export async function nativePublicConversationDigest(options: Omit<NativeConversationMaterialOptions, 'maximumBytes' | 'preparedUserContext'>): Promise<string> {
  const digest = new ConversationDigest();
  if (!options.sessionId || options.messages.length > 100_000) throw new Error('Native continuation history bounds');
  for (const message of options.messages) {
    options.signal?.throwIfAborted();
    const encoded = await encodeNativeConversationMessage(message, async block => {
      const entry = await readNativeConversationAttachment(options.sessionId, block, 16 * 1024 * 1024, options.readDocument, options.signal);
      entry.bytes.fill(0); return entry.reference;
    });
    digest.add(encoded);
  }
  return digest.finish();
}

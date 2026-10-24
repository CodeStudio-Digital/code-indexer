import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import type { NativeSessionReader, NativeConversationMaterialOptions } from '@mcp/agent-runtime-host';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { NativeSessionAttachments } from '../../../packages/agent-runtime-host/src/native/NativeSessionAttachments.js';
import { nativePublicConversationDigest } from '../../../packages/agent-runtime-host/src/native/NativeConversationDigest.js';
import { sealNativeContinuation, type NativeContinuationProof } from './native-coder-continuation.js';
import { referencedArtifacts, readSelectedAttachments } from './native-continuation-attachments.js';

/** Public history verifies the exact durable transcript incrementally; only
 * the authenticated model window and its referenced artifacts are hydrated. */
export class NativeRootContinuation {
  private closed = false;
  private constructor(readonly proof: NativeContinuationProof, private readonly context: wire.ProviderResumeContextV1,
    readonly artifacts: readonly artifact.ArtifactRef[], readonly artifactReader: NativeSessionAttachments) {}

  static async open(reader: NativeSessionReader, proof: NativeContinuationProof,
    history: Omit<NativeConversationMaterialOptions, 'maximumBytes' | 'preparedUserContext'>): Promise<NativeRootContinuation> {
    history.signal?.throwIfAborted();
    if (history.sessionId !== reader.state.sessionId || proof.sourceAttemptId !== reader.state.authority?.writerId
      || proof.committedRecords !== String(reader.state.committedRecords)
      || proof.lastCommitSha256 !== Buffer.from(reader.state.lastCommitSha256).toString('hex')) throw new Error('Native continuation source authority diverged');
    if (await nativePublicConversationDigest(history) !== proof.messagesSha256) throw new Error('Native continuation history differs from its durable frontier');
    if (!proof.compactedContextBase64 || proof.compactedContextBase64.length > Math.ceil(8 * 1024 * 1024 / 3) * 4) {
      throw new Error('Native continuation bounded frontier is missing or excessive');
    }
    // protobuf clone uses .slice() for bytes; decode a plain Uint8Array so a
    // Node Buffer view cannot survive zeroization through Buffer.slice().
    const bytes = Uint8Array.from(Buffer.from(proof.compactedContextBase64, 'base64'));
    let modelContext: wire.ProviderTurnContext;
    try {
      if (bytes.length > 8 * 1024 * 1024) throw new Error('Native continuation bounded frontier is excessive');
      modelContext = clone(wire.ProviderTurnContextSchema, fromBinary(wire.ProviderTurnContextSchema, bytes));
    } finally { bytes.fill(0); }
    modelContext.previousResponseId = undefined; modelContext.previousResponseMessageCount = undefined; modelContext.pendingChapters = [];
    const context = create(wire.ProviderResumeContextV1Schema, { schemaVersion: 1, sessionId: history.sessionId,
      agentRunId: proof.sourceAgentRunId, sourceAttemptId: proof.sourceAttemptId, context: modelContext });
    const attachments = new NativeSessionAttachments(history.sessionId, { includeToolOutputs: true });
    try {
      const references = referencedArtifacts(context);
      await readSelectedAttachments(reader, references, attachments, history.signal ?? new AbortController().signal);
      await reader.assertCurrent(); history.signal?.throwIfAborted();
      return new NativeRootContinuation(proof, context, references, attachments);
    } catch (cause) { attachments.close(); throw cause; }
  }

  prepare(material: Awaited<ReturnType<typeof prepareNativeCoderContext>>, agentRunId: string) {
    if (this.closed) throw new Error('Native continuation material closed');
    const context = clone(wire.ProviderResumeContextV1Schema, this.context);
    context.agentRunId = agentRunId; context.providerBinding = material.providerBinding;
    return sealNativeContinuation(material, this.proof, context.sessionId, toBinary(wire.ProviderResumeContextV1Schema, context));
  }
  hasArtifact(id: string) { return !this.closed && this.artifacts.some(reference => reference.artifactId === id); }
  close() { this.closed = true; this.artifactReader.close(); this.context.context!.messages.length = 0; }
}

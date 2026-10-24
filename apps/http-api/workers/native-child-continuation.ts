import { createHash } from 'node:crypto';
import { clone, create, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader, type VerifiedRuntimePackage } from '@mcp/agent-runtime-host';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { NativeChildContinuationAttachments } from './native-child-continuation-attachments.js';
import { resolveNativeChildSessionRoot } from '../native-child-storage.js';
import { inspectNativeContinuation, sealNativeContinuation, type NativeContinuationProof } from './native-coder-continuation.js';
import { validateNativeInbox, type NativeTreeInboxEntry } from '../native-tree-inbox.js';

/** Immutable source material, scoped to one authorized resume. No old writer,
 * live provider handle or unconfirmed capability result is transferred. */
export class NativeChildContinuation {
  private closed = false;
  private constructor(readonly proof: NativeContinuationProof, private readonly context: wire.ProviderResumeContextV1,
    readonly artifacts: readonly artifact.ArtifactRef[], readonly artifactReader: NativeChildContinuationAttachments,
    readonly inbox: readonly NativeTreeInboxEntry[]) {}

  static async open(input: { context: ControlPlaneRunContext; rootPath: string; runtimePackage: VerifiedRuntimePackage;
    allowCompleted?: boolean;
    inbox?: readonly NativeTreeInboxEntry[];
    provider: string; model: string; signal: AbortSignal; assertOwner(): Promise<void> }): Promise<NativeChildContinuation> {
    input.signal.throwIfAborted(); await input.assertOwner();
    const rootPath = await resolveNativeChildSessionRoot(input.rootPath, input.context);
    const reader = await NativeSessionReader.open(input.runtimePackage, { rootPath, sessionId: input.context.sessionId });
    let attachments: NativeChildContinuationAttachments | undefined;
    try {
      if (reader.state.archived || reader.state.authority?.writerId !== input.context.attemptId) throw new Error('Native child resume source writer differs');
      let context: wire.ProviderResumeContextV1 | undefined;
      const proof = await inspectNativeContinuation(reader, true, value => { context = value; }, { allowCompleted: input.allowCompleted });
      if (!proof || !context || proof.sourceAgentRunId !== input.context.agentRunId
        || context.providerBinding?.effectiveProvider !== input.provider || context.providerBinding.effectiveModel !== input.model) {
        throw new Error('Native child resume source identity or configured provider differs');
      }
      attachments = await NativeChildContinuationAttachments.open(reader, context, input.signal);
      const references = attachments.artifacts;
      await reader.assertCurrent(); await input.assertOwner(); input.signal.throwIfAborted();
      return new NativeChildContinuation(proof, context, references, attachments, validateNativeInbox(input.inbox ?? []));
    } catch (cause) { attachments?.close(); throw cause; }
    finally { try { await reader.close(); } catch (cause) { attachments?.close(); throw cause; } }
  }

  prepare(material: Awaited<ReturnType<typeof prepareNativeCoderContext>>, agentRunId: string, guidance: string) {
    if (this.closed || !guidance.trim() || Buffer.byteLength(guidance) > 64 * 1024) throw new Error('Native child resume guidance is missing or excessive');
    const context = clone(wire.ProviderResumeContextV1Schema, this.context);
    context.agentRunId = agentRunId; context.providerBinding = material.providerBinding;
    context.context!.messages.push(create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
      content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value: guidance } } } }] }));
    const proof = { ...this.proof, guidanceSha256: createHash('sha256').update(guidance).digest('hex') };
    return sealNativeContinuation(material, proof, context.sessionId, toBinary(wire.ProviderResumeContextV1Schema, context));
  }

  hasArtifact(id: string) { return !this.closed && this.artifacts.some(reference => reference.artifactId === id); }
  close() { this.closed = true; this.artifactReader.close(); this.context.context!.messages.length = 0; }
}


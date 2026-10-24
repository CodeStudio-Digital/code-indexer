import { createHash, randomUUID } from 'node:crypto';
import { clone, create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact, agentV1Runtime as wire, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { inspectUnresolvedCapabilityDispatches, decodeProviderFrontier, type NativeSessionReader } from '@mcp/agent-runtime-host';
import type { HostHydrationSource } from '../../../packages/agent-runtime-host/src/ipc/HostDataHydration.js';
import type { prepareNativeCoderContext } from '@mcp/code-agent/runtime/native-coder-context.js';
import { NativeContinuationTail } from './native-continuation-tail.js';
import { latestProviderCheckpointBase } from '../../../packages/agent-runtime-host/src/native/NativeProviderCheckpointIndex.js';
import { expandContextChapters } from '../../../packages/agent-runtime-host/src/native/NativeContextChapters.js';
import { nativeConversationDigest } from '../../../packages/agent-runtime-host/src/native/NativeConversationDigest.js';
import { NATIVE_SESSION_MAX_RECORDS } from '../../../packages/agent-runtime-host/src/native/NativeSessionStoreLimits.js';

export interface NativeContinuationProof {
  sourceAttemptId: string; sourceAgentRunId: string; committedRecords: string; lastCommitSha256: string;
  messagesSha256: string;
  /** Authenticated bounded model window, separate from the full public history. */
  compactedContextBase64?: string;
  guidanceSha256?: string;
  preparedUserContext?: { messageIndex: number; selectedSkillIds: string[]; contentUtf8: string };
  preparedBoundaryContext?: { messageIndex: number; sourceMessageSha256Hex: string; contentUtf8: string };
}
export const CONTINUATION_TASK = 'Continue the validated durable conversation without adding a user message.';

/** Every new command must first expose unresolved effects instead of giving
 * the model an opportunity to repeat a mutation whose ACK was lost. */
export async function inspectNativeContinuation(reader: NativeSessionReader, resume: boolean,
  capture?: (context: wire.ProviderResumeContextV1) => void,
  options: { allowCompleted?: boolean; assertWorkspaceTransition?: (sourceAttemptId: string) => Promise<void> } = {}): Promise<NativeContinuationProof | undefined> {
  const writer = reader.state.authority!.writerId;
  let sourceAgentRunId: string | undefined;
  let completed = false;
  let workspaceTransition = false;
  let frontier: ReturnType<typeof decodeProviderFrontier> | undefined;
  let effectAfterFrontier = false;
  const tail = resume ? new NativeContinuationTail() : undefined;
  const firstCheckpoint = resume
    ? await latestProviderCheckpointBase(reader.store, reader.state.sessionId, writer, NATIVE_SESSION_MAX_RECORDS, 'sourceAttemptId')
    : reader.state.committedRecords + 1n;
  const unresolved = await inspectUnresolvedCapabilityDispatches(reader.store, reader.state.sessionId, NATIVE_SESSION_MAX_RECORDS,
    (receipt, bytes, event) => {
      if (!event) {
        if (!resume) return;
        const envelope = fromBinary(wire.ProviderFrontierRecordV1Schema, bytes);
        if (envelope.frontier?.sourceAttemptId !== writer) return;
        frontier = decodeProviderFrontier(bytes, frontier);
        if (frontier.value.sessionId !== reader.state.sessionId
          || receipt.durability !== journal.SessionDurabilityClass.AUTHORITATIVE) throw new Error('Native continuation frontier authority diverged');
        effectAfterFrontier = false;
        tail?.reset(frontier.operationId);
        return;
      }
      if (event?.identity?.attemptId !== writer) return;
      if (receipt.globalSequence >= firstCheckpoint) tail?.accept(event);
      sourceAgentRunId = event.identity.agentRunId;
      if (event.body.case === 'capabilityDispatchStarted') effectAfterFrontier = true;
      if (event.body.case === 'terminal' && event.body.value.classification === journal.EngineTerminalClassificationV1.COMPLETED) completed = true;
      if (event.body.case === 'terminal' && event.body.value.reasonCode === 'workspace_transition') workspaceTransition = true;
    }, firstCheckpoint);
  await reader.assertCurrent();
  if (unresolved.length) throw new Error('Native session has unresolved effects; explicit reconciliation is required before another command');
  if (workspaceTransition) {
    if (!options.assertWorkspaceTransition) throw new Error('Native workspace transition requires confirmed materialization before another command');
    await options.assertWorkspaceTransition(writer);
    await reader.assertCurrent();
  }
  if (!resume) return undefined;
  if (!sourceAgentRunId || (completed && !options.allowCompleted) || !frontier || frontier.value.agentRunId !== sourceAgentRunId || effectAfterFrontier) {
    throw new Error('Native session has no settled interrupted continuation frontier');
  }
  const recovered = clone(wire.ProviderResumeContextV1Schema, frontier.value);
  recovered.context!.messages.push(...(tail?.messages() ?? []));
  const expanded = await expandContextChapters(reader.store, reader.state.sessionId, recovered.context!.messages);
  const digest = nativeConversationDigest(expanded);
  await reader.assertCurrent();
  capture?.(recovered);
  return { sourceAttemptId: writer, sourceAgentRunId, committedRecords: String(reader.state.committedRecords),
    lastCommitSha256: Buffer.from(reader.state.lastCommitSha256).toString('hex'),
    messagesSha256: digest,
    compactedContextBase64: Buffer.from(toBinary(wire.ProviderTurnContextSchema,
      create(wire.ProviderTurnContextSchema, { messages: recovered.context!.messages,
        preparedUserContext: recovered.context!.preparedUserContext,
        preparedBoundaryContext: recovered.context!.preparedBoundaryContext }))).toString('base64'),
    ...(frontier.value.context!.preparedBoundaryContext ? { preparedBoundaryContext: {
      messageIndex: frontier.value.context!.preparedBoundaryContext.messageIndex,
      sourceMessageSha256Hex: Buffer.from(frontier.value.context!.preparedBoundaryContext.sourceMessageSha256).toString('hex'),
      contentUtf8: frontier.value.context!.preparedBoundaryContext.contentUtf8,
    } } : {}),
    ...(frontier.value.context!.preparedUserContext ? { preparedUserContext: {
      messageIndex: frontier.value.context!.preparedUserContext.messageIndex,
      selectedSkillIds: [...frontier.value.context!.preparedUserContext.selectedSkillIds],
      contentUtf8: frontier.value.context!.preparedUserContext.contentUtf8,
    } } : {}) };
}

/** Mint a new command's continuation from its product history, not a replay
 * of an old effect. The original writer/head proof is separately sealed in
 * the verifier snapshot; old provider response IDs are deliberately absent. */
export async function prepareNativeContinuation(material: Awaited<ReturnType<typeof prepareNativeCoderContext>>,
  proof: NativeContinuationProof, sessionId: string, agentRunId: string) {
  const ordinal = material.source.items.findIndex(item => item.reference.case === 'snapshot'
    && item.reference.value.ref === material.initialConversationSnapshot.ref);
  const item = material.source.items[ordinal];
  if (!item || item.byteLength > 8n * 1024n * 1024n) throw new Error('Native continuation snapshot is missing or excessive');
  const encoded = await material.source.readExact(ordinal, 0n, Number(item.byteLength));
  let bytes: Uint8Array;
  try {
    const initial = fromBinary(wire.InitialConversationSnapshotV1Schema, encoded);
    const marker = initial.messages.pop();
    if (marker?.role !== wire.ProviderMessageRole.USER || marker.content.length !== 1
      || marker.content[0]?.body.case !== 'text' || marker.content[0].body.value.body.case !== 'inlineUtf8'
      || marker.content[0].body.value.body.value !== CONTINUATION_TASK || !initial.messages.length) {
      throw new Error('Native continuation task marker diverged');
    }
    if (nativeConversationDigest(initial.messages) !== proof.messagesSha256) throw new Error('Native continuation history differs from its durable frontier');
    const modelContext = proof.compactedContextBase64
      ? fromBinary(wire.ProviderTurnContextSchema, Buffer.from(proof.compactedContextBase64, 'base64'))
      : create(wire.ProviderTurnContextSchema, { messages: initial.messages, preparedUserContext: proof.preparedUserContext,
        preparedBoundaryContext: proof.preparedBoundaryContext ? {
          messageIndex: proof.preparedBoundaryContext.messageIndex, contentUtf8: proof.preparedBoundaryContext.contentUtf8,
          sourceMessageSha256: Buffer.from(proof.preparedBoundaryContext.sourceMessageSha256Hex, 'hex'),
        } : undefined });
    modelContext.previousResponseId = undefined; modelContext.previousResponseMessageCount = undefined;
    modelContext.pendingChapters = [];
    bytes = toBinary(wire.ProviderResumeContextV1Schema, create(wire.ProviderResumeContextV1Schema, {
      schemaVersion: 1, sessionId, agentRunId, sourceAttemptId: proof.sourceAttemptId,
      providerBinding: material.providerBinding, context: modelContext,
    }));
  } finally { encoded.fill(0); }
  return sealNativeContinuation(material, proof, sessionId, bytes);
}

/** Reuses the same private hydration boundary for an authorized child frontier. */
export function sealNativeContinuation(material: Awaited<ReturnType<typeof prepareNativeCoderContext>>,
  proof: NativeContinuationProof, sessionId: string, bytes: Uint8Array) {
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Native continuation exceeds its context budget');
  const ordinal = material.source.items.findIndex(item => item.reference.case === 'snapshot'
    && item.reference.value.ref === material.initialConversationSnapshot.ref);
  if (ordinal < 0) throw new Error('Native continuation snapshot is missing');
  const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), kind: 'product-continuation',
    ownerSessionId: sessionId, mediaType: 'application/vnd.codestudio.provider-resume.v1+protobuf',
    contentSha256: createHash('sha256').update(bytes).digest(), byteLength: BigInt(bytes.length),
    compression: artifact.ArtifactCompression.NONE, privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL,
    redactionPolicyVersion: 'product-continuation-v1' });
  const ordinals = material.source.items.map((_, index) => index).filter(index => index !== ordinal);
  let closed = false;
  const source: HostHydrationSource = {
    items: [...ordinals.map(index => material.source.items[index]!),
      { reference: { case: 'artifact', value: reference }, byteLength: BigInt(bytes.length) }],
    readExact(index, offset, length, signal) {
      signal?.throwIfAborted();
      if (closed) throw new Error('Native continuation material closed');
      if (index < ordinals.length) return material.source.readExact(ordinals[index]!, offset, length, signal);
      if (index !== ordinals.length || offset < 0n || !Number.isSafeInteger(length) || length < 1 || offset + BigInt(length) > BigInt(bytes.length)) {
        throw new Error('Native continuation read exceeds its sealed material');
      }
      return Promise.resolve(bytes.slice(Number(offset), Number(offset) + length));
    },
    async close(cause) { closed = true; bytes.fill(0); await material.source.close(cause); },
  };
  return { proof, reference, source };
}


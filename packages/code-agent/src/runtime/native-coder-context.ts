import { createHash, randomUUID } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime as wire, type CoderAttemptPreparationV1 } from '@mcp/agent-runtime-contracts';
import { createNativeConversationMaterial, type NativeConversationMaterialOptions } from '@mcp/agent-runtime-host';
import type { ToolRegistry } from '../core/registry.js';
import { createHostCapabilitySnapshot } from './host-capability-snapshot.js';

export interface NativeCoderContextInput extends Omit<NativeConversationMaterialOptions, 'sessionId'> {
  readonly preparation: CoderAttemptPreparationV1;
  readonly registry: ToolRegistry;
  readonly systemPrompt: string;
  readonly thinking: boolean;
  readonly thinkingBudgetTokens?: number;
}

/** Compile the existing worker's resolved inputs, without resolving another
 * provider/model or admitting a legacy attempt. Environment/workspace authority
 * and runtime selection remain with the product control plane. */
export async function prepareNativeCoderContext(input: NativeCoderContextInput) {
  const preparation = structuredClone(input.preparation);
  const systemPrompt = input.systemPrompt;
  const thinking = input.thinking;
  const thinkingBudgetTokens = input.thinkingBudgetTokens;
  if (createHash('sha256').update(systemPrompt).digest('hex') !== preparation.systemPromptSha256
    || !preparation.provider || !preparation.model || !preparation.agentDefinitionId
    || (thinkingBudgetTokens !== undefined && (!thinking || !Number.isSafeInteger(thinkingBudgetTokens) || thinkingBudgetTokens < 1))) {
    throw new Error('Native context differs from the resolved worker preparation');
  }
  const capabilitySnapshot = createHostCapabilitySnapshot(input.registry, preparation.capabilitySet);
  const definition = toBinary(wire.AgentDefinitionSnapshotV1Schema, create(wire.AgentDefinitionSnapshotV1Schema, {
    schemaVersion: 1, agentDefinitionId: preparation.agentDefinitionId, systemPromptUtf8: systemPrompt,
  }));
  const preset = toBinary(wire.ProviderPresetSnapshotV1Schema, create(wire.ProviderPresetSnapshotV1Schema, {
    schemaVersion: 1, effectivePreset: preparation.agentDefinitionId, thinking,
    thinkingBudgetTokens: thinkingBudgetTokens === undefined ? undefined : BigInt(thinkingBudgetTokens),
  }));
  const entries = [
    snapshot('definition', 'codestudio.agent.v1.AgentDefinitionSnapshotV1', definition),
    snapshot('capabilities', 'codestudio.agent.v1.CapabilitySetSnapshotV1', capabilitySnapshot.encodedSnapshot),
    snapshot('preset', 'codestudio.agent.v1.ProviderPresetSnapshotV1', preset),
  ];
  const fixedBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (fixedBytes >= input.maximumBytes) throw new Error('Native context exceeds its material byte budget');
  const material = await createNativeConversationMaterial({ sessionId: preparation.sessionId, messages: input.messages,
    preparedUserContext: input.preparedUserContext,
    maximumBytes: input.maximumBytes - fixedBytes, readDocument: input.readDocument, signal: input.signal });
  let hydrationClosed = false;
  const source = {
    items: [...entries.map((entry) => ({ reference: { case: 'snapshot' as const, value: structuredClone(entry.reference) },
      byteLength: BigInt(entry.bytes.length) })), ...material.source.items],
    async readExact(ordinal: number, offset: bigint, length: number, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (hydrationClosed) throw new Error('Native context hydration is closed');
      if (ordinal >= entries.length) return material.source.readExact(ordinal - entries.length, offset, length, signal);
      const entry = entries[ordinal];
      if (!entry || offset < 0n || !Number.isSafeInteger(length) || length < 1 || offset + BigInt(length) > BigInt(entry.bytes.length)) {
        throw new Error('Native context read is outside its material');
      }
      return entry.bytes.slice(Number(offset), Number(offset) + length);
    },
    async close(cause?: unknown) {
      hydrationClosed = true;
      for (const entry of entries) entry.bytes.fill(0);
      await material.source.close(cause);
    },
  };
  return { source, capabilitySnapshot, artifactReader: material.artifactReader, artifacts: material.artifacts, task: material.task,
    definitionSnapshot: structuredClone(entries[0]!.reference), capabilitySetSnapshot: structuredClone(entries[1]!.reference),
    presetSnapshot: structuredClone(entries[2]!.reference), initialConversationSnapshot: material.reference,
    providerBinding: create(wire.ProviderBindingSchema, { effectiveProvider: preparation.provider, effectiveModel: preparation.model,
      effectiveReasoningEffort: preparation.reasoningEffort, effectivePreset: preparation.agentDefinitionId }),
    async close() { await source.close(); material.close(); },
  };
}

function snapshot(label: string, schemaId: string, bytes: Uint8Array) {
  return { bytes: Uint8Array.from(bytes), reference: create(agentV1Common.SnapshotRefSchema, {
    ref: `coder-${label}:${randomUUID()}`, version: 1n, origin: 'coder-worker-preparation', schemaId, schemaVersion: 1,
    contentSha256: Uint8Array.from(createHash('sha256').update(bytes).digest()),
  }) };
}

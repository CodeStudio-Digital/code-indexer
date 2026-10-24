import { createHash } from 'node:crypto';
import { create, createRegistry, equals, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { validatePreparedUserContext } from './PreparedUserContext.js';
import { validatePreparedBoundaryContext } from './PreparedBoundaryContext.js';
import { NATIVE_SESSION_PAYLOAD_BYTES } from './NativeSessionStoreLimits.js';

const prefixEquality = { registry: createRegistry(), unknown: true };

export const MAX_FRONTIER_BYTES = NATIVE_SESSION_PAYLOAD_BYTES;
export interface ProviderFrontier {
  operationId: string;
  value: wire.ProviderResumeContextV1;
  digest: Uint8Array;
}

export function encodeProviderFrontier(start: wire.ProviderStart, previous?: ProviderFrontier) {
  const encoded = encodeFrontierRecord(start, previous);
  return { payload: encoded.payload,
    frontier: { operationId: start.operationId,
      value: fromBinary(wire.ProviderResumeContextV1Schema, encoded.full), digest: encoded.digest } };
}

/** Retains an owned projection for one writer. No message objects escape, so
 * an unchanged historical prefix can be shared without copying it each turn. */
export class OwnedProviderFrontierEncoder {
  #previous?: ProviderFrontier;

  encode(start: wire.ProviderStart, fullCheckpoint = false): Uint8Array {
    const encoded = encodeFrontierRecord(start, fullCheckpoint ? undefined : this.#previous);
    // Decode the committed fragment to isolate all caller-owned objects and
    // byte arrays. A delta contains only the new messages and current metadata.
    const value = fromBinary(wire.ProviderFrontierRecordV1Schema, encoded.payload.slice()).frontier!;
    if (encoded.base) {
      value.context!.messages = [...encoded.base.value.context!.messages, ...value.context!.messages];
    }
    this.#previous = { operationId: start.operationId, value, digest: encoded.digest };
    return encoded.payload;
  }
}

function encodeFrontierRecord(start: wire.ProviderStart, previous?: ProviderFrontier) {
  const identity = start.identity;
  if (!identity || !start.binding || !start.operationId) throw new Error('frontier authority missing');
  const context = create(wire.ProviderTurnContextSchema, {
    system: start.system, messages: start.messages, tools: start.tools,
    thinking: start.thinking, reasoningEffort: start.reasoningEffort,
    thinkingBudgetTokens: start.thinkingBudgetTokens,
    previousResponseId: start.previousResponseId,
    previousResponseMessageCount: start.previousResponseMessageCount,
    preparedUserContext: start.preparedUserContext,
    preparedBoundaryContext: start.preparedBoundaryContext,
  });
  const value = create(wire.ProviderResumeContextV1Schema, {
    schemaVersion: 1, sessionId: identity.sessionId, agentRunId: identity.agentRunId,
    sourceAttemptId: identity.attemptId, providerBinding: start.binding, context,
  });
  validateFrontier(value);
  const full = toBinary(wire.ProviderResumeContextV1Schema, value);
  if (full.length > MAX_FRONTIER_BYTES) throw new Error('provider frontier byte limit');
  const digest = sha256(full);
  let base: ProviderFrontier | undefined;
  // Bounded full checkpoints cap the replay chain. A changed prefix (including
  // compaction) creates a new base instead of silently keeping stale messages.
  if (previous && sameOwner(previous.value, value)) {
    const prefix = previous.value.context!.messages;
    if (prefix.length <= context.messages.length && prefix.every((message, index) =>
      equals(wire.ProviderMessageSchema, message, context.messages[index]!, prefixEquality))) {
      base = previous;
    }
  }
  // This borrowed view only exists during synchronous serialization. Retained
  // projections decode the result to isolate later edits by the caller.
  const fragment = create(wire.ProviderResumeContextV1Schema, { ...value,
    context: create(wire.ProviderTurnContextSchema, { ...context,
      messages: base ? context.messages.slice(base.value.context!.messages.length) : context.messages }),
  });
  const record = create(wire.ProviderFrontierRecordV1Schema, {
    schemaVersion: 1, operationId: start.operationId, frontier: fragment,
    baseOperationId: base?.operationId ?? '',
    retainedMessageCount: BigInt(base?.value.context!.messages.length ?? 0),
    baseFrontierSha256: base?.digest ?? new Uint8Array(), frontierSha256: digest,
  });
  const payload = toBinary(wire.ProviderFrontierRecordV1Schema, record);
  if (payload.length > MAX_FRONTIER_BYTES) throw new Error('provider frontier byte limit');
  return { payload, full, digest, base };
}

export function decodeProviderFrontier(payload: Uint8Array, previous?: ProviderFrontier): ProviderFrontier {
  if (!payload.length || payload.length > MAX_FRONTIER_BYTES) throw new Error('provider frontier byte limit');
  const record = fromBinary(wire.ProviderFrontierRecordV1Schema, payload);
  if (!equal(toBinary(wire.ProviderFrontierRecordV1Schema, record), payload)
    || record.schemaVersion !== 1 || !record.operationId || record.operationId.length > 1_024
    || !record.frontier?.context) throw new Error('provider frontier is not canonical');
  const value = record.frontier;
  if (record.baseOperationId) {
    if (!previous || previous.operationId !== record.baseOperationId
      || !sameOwner(previous.value, value) || !equal(previous.digest, record.baseFrontierSha256)
      || record.retainedMessageCount !== BigInt(previous.value.context!.messages.length)) {
      throw new Error('provider frontier base diverged');
    }
    value.context!.messages = [...previous.value.context!.messages, ...value.context!.messages];
  } else if (record.retainedMessageCount !== 0n || record.baseFrontierSha256.length) {
    throw new Error('full provider frontier has a delta base');
  }
  validateFrontier(value);
  const encoded = toBinary(wire.ProviderResumeContextV1Schema, value);
  if (encoded.length > MAX_FRONTIER_BYTES || !equal(sha256(encoded), record.frontierSha256)) {
    throw new Error('provider frontier digest diverged');
  }
  return { operationId: record.operationId, value, digest: record.frontierSha256 };
}

function validateFrontier(value: wire.ProviderResumeContextV1): void {
  const context = value.context;
  if (value.schemaVersion !== 1 || !value.sessionId || !value.agentRunId || !value.sourceAttemptId
    || !value.providerBinding?.effectiveProvider || !value.providerBinding.effectiveModel
    || value.unresolvedCapabilityOperationIds.length || !context?.messages.length
    || context.messages.length > 100_000 || context.previousResponseId === ''
    || (context.previousResponseMessageCount !== undefined && (!context.previousResponseId
      || context.previousResponseMessageCount > BigInt(context.messages.length)))) {
    throw new Error('provider frontier is unresolved or invalid');
  }
  validateProviderConversation(context.messages);
  validatePreparedUserContext(context.preparedUserContext, context.messages);
  validatePreparedBoundaryContext(context.preparedBoundaryContext, context.messages);
}

export function validateProviderConversation(messages: readonly wire.ProviderMessage[]): void {
  if (!messages.length || messages.length > 100_000) throw new Error('provider conversation size is invalid');
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (![wire.ProviderMessageRole.USER, wire.ProviderMessageRole.ASSISTANT, wire.ProviderMessageRole.TOOL].includes(message.role)
      || !message.content.length || (message.role !== wire.ProviderMessageRole.TOOL && pending.size)) {
      throw new Error('provider frontier message order is invalid');
    }
    // Remote IDs are scoped to their assistant message. A completed earlier
    // call must not prevent the provider from reusing that ID on a later turn.
    if (message.role !== wire.ProviderMessageRole.TOOL) seen.clear();
    for (const { body } of message.content) {
      if (body.case === 'toolUse') {
        const call = body.value;
        if (message.role !== wire.ProviderMessageRole.ASSISTANT || !call.toolUseId || !call.capabilityName
          || seen.has(call.toolUseId) || !equal(sha256(call.encodedJsonArguments), call.argumentsSha256)) {
          throw new Error('provider frontier tool call is invalid');
        }
        seen.add(call.toolUseId); pending.add(call.toolUseId);
      } else if (body.case === 'toolResult') {
        if (message.role !== wire.ProviderMessageRole.TOOL || !body.value.content.case
          || !pending.delete(body.value.toolUseId)) throw new Error('provider frontier tool result is invalid');
      } else if (!body.case || message.role === wire.ProviderMessageRole.TOOL
        || (body.case === 'thinking' && message.role !== wire.ProviderMessageRole.ASSISTANT)) {
        throw new Error('provider frontier message content is invalid');
      }
    }
  }
  if (pending.size) throw new Error('provider frontier has unanswered tools');
}

function sameOwner(a: wire.ProviderResumeContextV1, b: wire.ProviderResumeContextV1): boolean {
  return a.sessionId === b.sessionId && a.agentRunId === b.agentRunId && a.sourceAttemptId === b.sourceAttemptId
    && equal(toBinary(wire.ProviderBindingSchema, a.providerBinding!), toBinary(wire.ProviderBindingSchema, b.providerBinding!));
}
export function sha256(bytes: Uint8Array): Uint8Array { return new Uint8Array(createHash('sha256').update(bytes).digest()); }
function equal(a: Uint8Array, b: Uint8Array): boolean { return Buffer.from(a).equals(b); }

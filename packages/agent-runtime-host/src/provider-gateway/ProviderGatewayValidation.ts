import { createHash, timingSafeEqual } from 'node:crypto';
import {
  agentV1Artifact,
  agentV1Common,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ChatUsage, JsonSchema } from '@mcp/provider-sdk/wire.js';
import { validateAttemptIdentity } from '../ipc/FrameHeaderValidation.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import type { ProviderGatewayLimits } from './ProviderGatewayTypes.js';

const IDENTIFIER_MAX_BYTES = 256;
const REASON_MAX_BYTES = 128;

export function validateGatewayLimits(limits: ProviderGatewayLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalid(`${name} must be a positive safe integer`);
    }
  }
  if (limits.maxOperationMs > 2_147_483_647) {
    throw invalid('maxOperationMs exceeds the timer ceiling');
  }
  if (limits.maxToolSchemaBytes > limits.maxRequestBytes
    || limits.maxToolArgumentsBytes > limits.maxRequestBytes
    || limits.maxArtifactBytes > limits.maxRequestBytes) {
    throw invalid('per-item limits cannot exceed maxRequestBytes');
  }
}

export function validateProviderStart(
  start: agentV1Runtime.ProviderStart,
  requestPayloadSha256: Uint8Array,
  now: number,
  limits: ProviderGatewayLimits,
): asserts start is agentV1Runtime.ProviderStart & {
  identity: agentV1Common.AttemptIdentity;
  binding: agentV1Runtime.ProviderBinding;
} {
  if (!Number.isSafeInteger(now) || now <= 0) throw invalid('Host clock is invalid');
  if (!start.identity || !start.binding) throw invalid('identity and binding are required');
  validateAttemptIdentity(start.identity);
  boundedText(start.operationId, 'operationId');
  boundedText(start.idempotencyKey, 'idempotencyKey');
  boundedText(start.binding.effectiveProvider, 'effectiveProvider');
  boundedText(start.binding.effectiveModel, 'effectiveModel');
  if (requestPayloadSha256.byteLength !== 32) throw invalid('request digest must be SHA-256');
  const deadline = safeNumber(start.deadlineAtUnixMs, 'deadlineAtUnixMs');
  if (deadline <= now || deadline - now > limits.maxOperationMs) {
    throw new ProviderGatewayError(
      'provider_deadline_exceeded',
      'provider deadline is expired or exceeds the operation ceiling',
    );
  }
}

export function identityKey(identity: agentV1Common.AttemptIdentity): string {
  return [
    identity.sessionId,
    identity.commandId,
    identity.agentRunId,
    identity.attemptId,
    identity.executorOwnerId,
    identity.fencingEpoch.toString(),
    identity.correlationId,
  ].join('\u001f');
}

export function safeNumber(value: bigint, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(`${name} is out of range`);
  return number;
}

export function usageToWire(usage: ChatUsage): agentV1Runtime.ProviderUsage {
  const value = (input: number | undefined, name: string): bigint | undefined => {
    if (input === undefined) return undefined;
    if (!Number.isSafeInteger(input) || input < 0) throw invalid(`${name} is invalid`);
    return BigInt(input);
  };
  return {
    $typeName: 'codestudio.agent.v1.ProviderUsage',
    inputTokens: value(usage.input_tokens, 'input_tokens')!,
    outputTokens: value(usage.output_tokens, 'output_tokens')!,
    promptTokensTotal: value(usage.prompt_tokens_total, 'prompt_tokens_total'),
    cacheCreationInputTokens: value(
      usage.cache_creation_input_tokens,
      'cache_creation_input_tokens',
    ),
    cacheReadInputTokens: value(usage.cache_read_input_tokens, 'cache_read_input_tokens'),
    thinkingTokens: value(usage.thinking_tokens, 'thinking_tokens'),
  };
}

export function parseJsonObject(
  bytes: Uint8Array,
  expectedSha256: Uint8Array,
  maximumBytes: number,
  label: string,
): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw invalid(`${label} exceeds its byte bounds`);
  }
  if (expectedSha256.byteLength !== 32) throw invalid(`${label} digest must be SHA-256`);
  const actual = createHash('sha256').update(bytes).digest();
  if (!timingSafeEqual(actual, expectedSha256)) throw invalid(`${label} digest mismatch`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw invalid(`${label} is not valid UTF-8 JSON`, cause);
  }
  if (!isRecord(parsed)) throw invalid(`${label} must be a JSON object`);
  return parsed;
}

export function asJsonSchema(value: Record<string, unknown>): JsonSchema {
  if (value.type !== 'object' || !isRecord(value.properties)) {
    throw invalid('tool schema must define an object with properties');
  }
  if (value.required !== undefined && (
    !Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string')
  )) throw invalid('tool schema required must be a string array');
  return value as unknown as JsonSchema;
}

export function verifyArtifact(
  artifact: agentV1Artifact.ArtifactRef,
  bytes: Uint8Array,
  maximumBytes: number,
): void {
  if (artifact.compression !== agentV1Artifact.ArtifactCompression.NONE) {
    throw invalid('compressed provider artifacts are not supported by v1');
  }
  const declared = safeNumber(artifact.byteLength, 'artifact.byteLength');
  if (declared > maximumBytes || bytes.byteLength !== declared) {
    throw new ProviderGatewayError('provider_request_too_large', 'artifact byte length mismatch');
  }
  if (artifact.contentSha256.byteLength !== 32) throw invalid('artifact digest must be SHA-256');
  const actual = createHash('sha256').update(bytes).digest();
  if (!timingSafeEqual(actual, artifact.contentSha256)) throw invalid('artifact digest mismatch');
}

export function phaseToWire(
  phase: 'commentary' | 'final_answer' | undefined,
): agentV1Runtime.ProviderMessagePhase {
  if (phase === 'commentary') return agentV1Runtime.ProviderMessagePhase.COMMENTARY;
  if (phase === 'final_answer') return agentV1Runtime.ProviderMessagePhase.FINAL_ANSWER;
  return agentV1Runtime.ProviderMessagePhase.UNSPECIFIED;
}

export function terminalReason(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return Buffer.byteLength(sanitized) <= REASON_MAX_BYTES
    ? sanitized
    : sanitized.slice(0, REASON_MAX_BYTES);
}

export function boundedText(value: string, name: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes === 0 || bytes > IDENTIFIER_MAX_BYTES) throw invalid(`${name} is empty or oversized`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string, cause?: unknown): ProviderGatewayError {
  return new ProviderGatewayError('invalid_provider_request', message, { cause });
}

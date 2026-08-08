import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type {
  OssEngineAttemptSpec,
  OssEngineCapability,
  OssEngineToolContentItem,
  OssEngineToolReceipt,
} from './types.js';

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

export interface OssEngineValidationLimits {
  maxCapabilities: number;
  maxSchemaBytes: number;
  maxToolResultBytes: number;
}

export const DEFAULT_OSS_ENGINE_LIMITS: OssEngineValidationLimits = {
  maxCapabilities: 32,
  maxSchemaBytes: 12 * 1024,
  maxToolResultBytes: 64 * 1024,
};

export class OssEngineValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OssEngineValidationError';
  }
}

export function validateOssEngineAttemptSpec(
  spec: OssEngineAttemptSpec,
  limits: OssEngineValidationLimits = DEFAULT_OSS_ENGINE_LIMITS,
): void {
  requireText(spec.candidateVersion, 'candidate_version_missing');
  requireText(spec.protocolVersion, 'protocol_version_missing');
  if (!/^[a-f0-9]{64}$/.test(spec.protocolSchemaDigest)) {
    throw new OssEngineValidationError(
      'protocol_schema_digest_invalid',
      'Protocol schema digest must be a lowercase SHA-256 value',
    );
  }
  requireText(spec.authority.attemptId, 'attempt_id_missing');
  requireText(spec.prompt, 'prompt_missing');
  if (!isAbsolute(spec.cwd)) {
    throw new OssEngineValidationError('cwd_not_absolute', 'Engine cwd must be absolute');
  }
  if (spec.capabilities.length > limits.maxCapabilities) {
    throw new OssEngineValidationError(
      'capability_count_exceeded',
      `Attempt exposes ${spec.capabilities.length} capabilities; limit is ${limits.maxCapabilities}`,
    );
  }

  const identities = new Set<string>();
  const aliases = new Set<string>();
  let schemaBytes = 0;
  for (const capability of spec.capabilities) {
    validateCapability(capability);
    if (identities.has(capability.capabilityId)) {
      throw new OssEngineValidationError(
        'duplicate_capability_id',
        `Duplicate capability ${capability.capabilityId}`,
      );
    }
    identities.add(capability.capabilityId);
    const alias = dynamicToolAlias(capability);
    if (aliases.has(alias)) {
      throw new OssEngineValidationError('duplicate_tool_alias', `Duplicate dynamic tool alias ${alias}`);
    }
    aliases.add(alias);
    schemaBytes += Buffer.byteLength(JSON.stringify(capability.inputSchema), 'utf8');
  }
  if (schemaBytes > limits.maxSchemaBytes) {
    throw new OssEngineValidationError(
      'schema_budget_exceeded',
      `Dynamic tool schemas use ${schemaBytes} bytes; limit is ${limits.maxSchemaBytes}`,
    );
  }
}

export function dynamicToolAlias(capability: OssEngineCapability): string {
  const normalized = capability.canonicalName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const base = normalized.length > 0 ? normalized.slice(0, 110) : 'tool';
  const suffix = createHash('sha256')
    .update(capability.capabilityId)
    .update('\0')
    .update(capability.descriptorDigest)
    .digest('hex')
    .slice(0, 12);
  return `${base}_${suffix}`;
}

export function validateToolReceipt(
  receipt: OssEngineToolReceipt,
  expectedCallId: string,
  maxBytes: number,
): void {
  if (receipt.callId !== expectedCallId) {
    throw new OssEngineValidationError(
      'tool_receipt_call_mismatch',
      `ToolHost returned ${receipt.callId} for ${expectedCallId}`,
    );
  }
  if (!receipt.accepted && receipt.started) {
    throw new OssEngineValidationError(
      'tool_receipt_invalid_lifecycle',
      'A rejected tool call cannot have started',
    );
  }
  if (!receipt.accepted && receipt.outcome !== 'declined') {
    throw new OssEngineValidationError(
      'tool_receipt_invalid_lifecycle',
      'A rejected tool call must have a declined outcome',
    );
  }
  if (!receipt.started && receipt.outcome === 'completed') {
    throw new OssEngineValidationError(
      'tool_receipt_invalid_lifecycle',
      'A completed tool call must have started',
    );
  }
  const bytes = receipt.contentItems.reduce(
    (total, item) => total + validateContentItem(item),
    0,
  );
  if (bytes > maxBytes) {
    throw new OssEngineValidationError(
      'tool_result_budget_exceeded',
      `Tool result uses ${bytes} bytes; limit is ${maxBytes}`,
    );
  }
}

function validateCapability(capability: OssEngineCapability): void {
  requireText(capability.capabilityId, 'capability_id_missing');
  requireText(capability.canonicalName, 'capability_name_missing');
  if (!/^[a-f0-9]{64}$/.test(capability.descriptorDigest)) {
    throw new OssEngineValidationError(
      'capability_digest_invalid',
      `Capability ${capability.capabilityId} digest must be a lowercase SHA-256 value`,
    );
  }
  if (capability.description.length > 1024) {
    throw new OssEngineValidationError(
      'capability_description_too_large',
      `Capability ${capability.capabilityId} description exceeds 1024 characters`,
    );
  }
  if (!isPlainRecord(capability.inputSchema)) {
    throw new OssEngineValidationError(
      'capability_schema_invalid',
      `Capability ${capability.capabilityId} schema must be an object`,
    );
  }
  const alias = dynamicToolAlias(capability);
  if (!TOOL_NAME.test(alias)) {
    throw new OssEngineValidationError('capability_alias_invalid', `Invalid tool alias ${alias}`);
  }
}

function validateContentItem(item: OssEngineToolContentItem): number {
  if (item.type === 'inputText') {
    return Buffer.byteLength(item.text, 'utf8');
  }
  if (!item.imageUrl.startsWith('data:image/')) {
    throw new OssEngineValidationError(
      'remote_tool_image_rejected',
      'Dynamic tool images must be inline data URLs',
    );
  }
  return Buffer.byteLength(item.imageUrl, 'utf8');
}

function requireText(value: string, code: string): void {
  if (value.trim().length === 0) {
    throw new OssEngineValidationError(code, `${code.replaceAll('_', ' ')} is required`);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

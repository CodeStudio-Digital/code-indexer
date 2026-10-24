import { createHash, randomUUID } from 'node:crypto';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { type SessionCommandKind } from '@mcp/agent-runtime-contracts';

export const EXECUTOR_LEASE_MS = 10 * 60_000;

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function opaqueValueHash(value: unknown): string {
  try {
    return hashControlPlanePayload(value);
  } catch {
    const shape = value === null
      ? 'null'
      : Array.isArray(value)
        ? `array:${value.length}`
        : typeof value === 'object'
          ? `object:${Object.keys(value as object).sort().join(',')}`
          : typeof value;
    return digest(`non-json:${shape}`);
  }
}

export function stableUuid(value: string): string {
  const bytes = Buffer.from(digest(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function stableCommandKey(input: {
  sessionId: string;
  kind: SessionCommandKind;
  idempotencyKey?: string | null;
}): { key: string; digest: string } {
  const key = input.idempotencyKey ?? `server:${randomUUID()}`;
  return {
    key,
    digest: digest(`coder:${input.sessionId}:${input.kind}:${key}`),
  };
}

interface LocalCoderMessageFingerprintInput {
  content?: string;
  attachments?: Array<{ name: string; mediaType: string; path?: string; base64?: string; text?: string }>;
  resume?: boolean;
  agent?: string | null;
  profile?: string | null;
  planMode?: boolean;
  maxTurns?: number;
  selectedSkillIds?: string[];
  worktree?: { name?: string; branch?: string };
}

export function fingerprintLocalCoderMessage(input: LocalCoderMessageFingerprintInput): Record<string, unknown> {
  return {
    contentHash: digest(input.content ?? ''),
    contentChars: input.content?.length ?? 0,
    attachments: (input.attachments ?? []).map((attachment) => ({
      name: attachment.name,
      mediaType: attachment.mediaType,
      pathHash: attachment.path ? digest(attachment.path) : null,
      contentHash: digest(attachment.base64 ?? attachment.text ?? ''),
      encodedChars: attachment.base64?.length ?? attachment.text?.length ?? 0,
    })),
    resume: input.resume === true,
    agent: input.agent ?? null,
    profile: input.profile ?? null,
    planMode: input.planMode === true,
    maxTurns: input.maxTurns ?? null,
    selectedSkillIds: [...(input.selectedSkillIds ?? [])].sort(),
    worktree: input.worktree
      ? { name: input.worktree.name ?? null, branch: input.worktree.branch ?? null }
      : null,
  };
}

export function fingerprintLocalCompanyCommand(input: {
  message: string;
  attachments?: Array<{ name: string; mediaType: string; base64?: string; text?: string }>;
  thinking?: boolean;
  maxTurns?: number;
}): Record<string, unknown> {
  return {
    messageHash: digest(input.message),
    messageChars: input.message.length,
    attachments: (input.attachments ?? []).map((attachment) => ({
      nameHash: digest(attachment.name),
      mediaType: attachment.mediaType,
      contentHash: digest(attachment.base64 ?? attachment.text ?? ''),
      encodedChars: attachment.base64?.length ?? attachment.text?.length ?? 0,
    })),
    thinking: input.thinking === true,
    maxTurns: input.maxTurns ?? null,
  };
}

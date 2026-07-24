import type { AgentMessage } from '@mcp/code-agent/core/messages.js';

const REDACTED = '[REDACTED]';
const OMITTED_THINKING = '[thinking omitted from durable checkpoint]';
const SENSITIVE_KEY =
  /^(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|cookie|private[-_]?key|credential|client[-_]?secret)$|(?:^|[-_])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|private[-_]?key|client[-_]?secret)(?:$|[-_])/i;
const STRUCTURAL_OPAQUE_KEY = /(?:^|_)(?:id|ids|hash|fingerprint)$|(?:Id|Ids|Hash|Fingerprint)$|^dependsOn$/;

function shannonBitsPerChar(value: string): number {
  const frequencies = new Map<string, number>();
  for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

function redactOpaqueSecrets(input: string): string {
  return input.replace(/[A-Za-z0-9_\-+/=]{24,}/g, (token) =>
    shannonBitsPerChar(token) >= 3.5 ? REDACTED : token);
}

/**
 * Redacts credential-shaped material embedded in otherwise useful task/result
 * text. This is intentionally conservative: a resumed agent can re-read a
 * secret through its authorized tool/environment instead of recovering it
 * from a durable checkpoint.
 */
export function redactCheckpointText(input: string, strictOpaque = true): string {
  const redacted = input
    .replace(/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|rk_|rk-|pk-)[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
    .replace(/\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"')]+/gi, REDACTED)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASS|PWD|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[=:]\s*[^\s"']{6,}/g,
      (_match, key: string) => `${key}=${REDACTED}`,
    )
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|client[-_]?secret)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
    );
  return strictOpaque ? redactOpaqueSecrets(redacted) : redacted;
}

function sanitizeUnknown(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') {
    return redactCheckpointText(value, !STRUCTURAL_OPAQUE_KEY.test(key));
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[cycle omitted]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, key, seen));
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = sanitizeUnknown(childValue, childKey, seen);
  }
  return out;
}

/** Generic workflow/metadata projection sanitizer. */
export function sanitizeCheckpointValue<T>(value: T): T {
  return sanitizeUnknown(value) as T;
}

/**
 * Resume projection: remove private chain-of-thought and redact credential
 * values while preserving message/tool pairing needed by transcript repair.
 */
export function sanitizeMessagesForCheckpoint(messages: AgentMessage[]): AgentMessage[] {
  const sanitized = sanitizeCheckpointValue(messages);
  return sanitized.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === 'thinking'
        ? { ...block, text: OMITTED_THINKING }
        : block),
  }));
}

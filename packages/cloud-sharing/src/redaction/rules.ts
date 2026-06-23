/**
 * Redaction rule table — ordered secret/path/PII patterns. Each match becomes a
 * typed placeholder. This is the security core: a conversation's text can carry
 * API keys, tokens, private keys, connection strings, and absolute home paths
 * that reveal the user's machine + identity. Deny-by-default: structural blobs
 * (base64, tool_result bodies) are dropped at the snapshot level by TYPE; this
 * table scrubs what survives in free text.
 *
 * `strict` rules additionally redact emails + generic high-entropy strings.
 */
export type RedactionLevel = 'standard' | 'strict';

export interface Rule {
  readonly name: string;
  readonly re: RegExp; // MUST be global (we use replace-all + a hit counter)
  readonly to: string;
  readonly strictOnly?: boolean;
}

// Ordered: longest/most-specific structural secrets first, paths last, PII (strict) at the end.
export const RULES: readonly Rule[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g, to: '‹redacted:private-key›' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, to: '‹redacted:jwt›' },
  { name: 'anthropic_openai_key', re: /\b(?:sk-ant-|sk-proj-|sk-|rk_)[A-Za-z0-9_-]{16,}\b/g, to: '‹redacted:key›' },
  { name: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: '‹redacted:key›' },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, to: '‹redacted:token›' },
  { name: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, to: '‹redacted:key›' },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, to: '‹redacted:token›' },
  { name: 'connection_string', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"')]+/g, to: '‹redacted:connection-string›' },
  // KEY=value where the key name implies a secret. Capture the key, redact the value.
  { name: 'env_secret', re: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASS|PWD|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[=:]\s*[^\s"']{6,}/g, to: '$1=‹redacted›' },
  { name: 'win_home_path', re: /[A-Za-z]:\\(?:Users|home)\\[^\s"')]+/g, to: '‹path›' },
  { name: 'posix_home_path', re: /\/(?:home|Users)\/[^\s"')]+/g, to: '‹path›' },
  { name: 'root_path', re: /\/(?:root|var|etc|opt|tmp)\/[^\s"')]+/g, to: '‹path›' },
  { name: 'tilde_path', re: /~\/[^\s"')]+/g, to: '‹path›' },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, to: '‹email›', strictOnly: true },
];

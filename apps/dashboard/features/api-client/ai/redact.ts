/**
 * Best-effort redaction of LITERAL credentials before the request URL / body
 * sample is sent to the AI script assistant. `{{var}}` templates are already safe
 * (unresolved), but a user who pasted a raw token directly into the path or JSON
 * body would otherwise leak it to the model. These patterns are targeted (low
 * false-positive) — they mask obvious credential shapes and credential-named
 * query params, and never touch `{{template}}` placeholders.
 */
/** The placeholder substituted for a stripped secret. Exported so the sync apply
 *  path can detect a redacted body and avoid clobbering a real local value. */
export const REDACTION_PLACEHOLDER = '«redacted»';
const REDACTED = REDACTION_PLACEHOLDER;

export function redactSecrets(input: string | null | undefined): string {
  if (!input) return input ?? '';
  return input
    // JWTs (header.payload.signature)
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED)
    // Common provider key prefixes (sk-, pk-, rk-, ghp_, xoxb-, …)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\b(?:ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{10,}/g, REDACTED)
    // Authorization scheme + literal credential
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{12,}/gi, `$1 ${REDACTED}`)
    // credential-named query params — keep the key, redact the literal value
    // (but never a `{{template}}`)
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|key|sig|signature)=)(?!\{\{)([^&\s#]{6,})/gi, `$1${REDACTED}`);
}

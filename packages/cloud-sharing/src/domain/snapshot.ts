/**
 * The public block model — a deliberately NARROW subset of the live message
 * union. Anything not modeled here is structurally impossible to publish
 * (fail-closed by type): there is no `base64`, no raw `tool_result` body, no
 * `args_json` field anywhere in this shape.
 */
export type PublicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; inputSummary: string } // args reduced to a 1-line summary
  | { type: 'tool_result'; toolName: string; status: 'ok' | 'error'; redacted: true }
  | { type: 'image'; redacted: true } // base64 NEVER included
  | { type: 'document'; name: string | null; redacted: true };

export interface ShareMessage {
  idx: number; // 0-based stable order
  role: 'user' | 'assistant';
  blocks: PublicBlock[];
}

export interface ShareSnapshot {
  schemaVersion: 1;
  title: string;
  model: string | null; // "provider/model" label, never creds
  createdAtMs: number;
  messages: ShareMessage[];
}

/**
 * Canonical, deterministic JSON (sorted keys, stable array order) → UTF-8 bytes.
 * The signature is computed over exactly these bytes, so the verifier and signer
 * must agree byte-for-byte. We hand-roll the stringify to guarantee key order
 * regardless of how the object was constructed.
 */
export function canonicalize(s: ShareSnapshot): Uint8Array {
  return new TextEncoder().encode(stableStringify(s));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

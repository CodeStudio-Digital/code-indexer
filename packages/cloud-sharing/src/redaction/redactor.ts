/**
 * The redaction engine. Pure, no I/O. Runs the rule table over free text plus a
 * generic high-entropy catch (strict only), then projects a whole snapshot so the
 * server can RE-redact a client-supplied snapshot (defense in depth — the client
 * pass is a UX nicety, never the security boundary).
 */
import type { PublicBlock, ShareMessage, ShareSnapshot } from '../domain/snapshot.js';
import { RULES, type RedactionLevel } from './rules.js';

export interface RedactionResult<T> {
  value: T;
  redactionCount: number;
}

/** Redact one string. Returns the scrubbed text + number of items removed. */
export function redactText(input: string, level: RedactionLevel): RedactionResult<string> {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    if (rule.strictOnly && level !== 'strict') continue;
    text = text.replace(rule.re, (...args) => {
      count += 1;
      // A function replacer does NOT expand `$1`, so substitute capture groups
      // ourselves. args = [match, ...groups, offset, string].
      const groups = args.slice(1, -2) as string[];
      return rule.to.replace(/\$(\d+)/g, (_, n) => groups[Number(n) - 1] ?? '');
    });
  }
  if (level === 'strict') {
    const entropy = redactHighEntropy(text);
    text = entropy.value;
    count += entropy.redactionCount;
  }
  return { value: text, redactionCount: count };
}

/** Re-redact every text-bearing field of a snapshot. Blocks that carry no free
 *  text (image/document/tool_result) are already redacted-by-type. */
export function redactSnapshot(snapshot: ShareSnapshot, level: RedactionLevel): RedactionResult<ShareSnapshot> {
  let count = 0;
  const bump = (r: RedactionResult<string>) => {
    count += r.redactionCount;
    return r.value;
  };
  const title = bump(redactText(snapshot.title, level));
  const messages: ShareMessage[] = snapshot.messages.map((m) => ({
    idx: m.idx,
    role: m.role,
    blocks: m.blocks.map((b) => redactBlock(b, level, bump)),
  }));
  return { value: { ...snapshot, title, messages }, redactionCount: count };
}

function redactBlock(b: PublicBlock, level: RedactionLevel, bump: (r: RedactionResult<string>) => string): PublicBlock {
  if (b.type === 'text') return { type: 'text', text: bump(redactText(b.text, level)) };
  if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, inputSummary: bump(redactText(b.inputSummary, level)) };
  return b; // tool_result / image / document carry no free text
}

/** Strict-only: mask long, high-entropy tokens that no specific rule caught
 *  (opaque API keys, random ids). Skips ordinary words via a per-token entropy
 *  threshold so prose survives. */
function redactHighEntropy(text: string): RedactionResult<string> {
  let count = 0;
  const value = text.replace(/[A-Za-z0-9_\-+/=]{24,}/g, (tok) => {
    if (shannonBitsPerChar(tok) >= 3.5) {
      count += 1;
      return '‹redacted:secret›';
    }
    return tok;
  });
  return { value, redactionCount: count };
}

function shannonBitsPerChar(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

import { createHash } from 'node:crypto';

/**
 * Quality v2, D1 — short stable hash for nudge dedup. Uses sha1 hex
 * truncated to 16 chars (plenty of collision resistance for the 5-turn
 * window we compare against; we'd need >2^32 nudges in 5 turns to risk
 * a collision and that's not a real scenario).
 */
export function hashShort(text: string): string {
  try {
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
  } catch {
    // Fallback: length-based "hash" so we still have *something*; only
    // hit when crypto isn't available which shouldn't happen in Node.
    return `len-${text.length}`;
  }
}

/**
 * Quality v2, C4 — Convert a `quality_classifications` row into the
 * verdict-snapshot shape the intervention store expects. Trims `reason`
 * to a reasonable length so the JSON column doesn't bloat.
 */
export function rowToVerdictSnapshot(
  row: import('@mcp/store/quality-classification-store.js').QualityClassificationRow,
): import('@mcp/store/quality-intervention-store.js').InterventionVerdictSnapshot {
  return {
    classifierName: row.classifier_name,
    verdict: row.verdict,
    confidence: row.confidence,
    reason: row.reason ? row.reason.slice(0, 500) : null,
  };
}

/**
 * Compact preview of a tool call's input — first 80 chars of the
 * JSON-serialised args, with control chars stripped. Embedded in the
 * dup-result marker so the agent can recognise which earlier call
 * this duplicates without scanning the transcript.
 */
export function previewToolArgs(input: unknown): string {
  try {
    const raw = JSON.stringify(input ?? {});
    // Strip newlines + tabs so the marker stays a single line.
    const flat = raw.replace(/[\r\n\t]+/g, ' ');
    if (flat.length <= 80) return flat;
    return flat.slice(0, 77) + '...';
  } catch {
    return '<unserialisable>';
  }
}

/**
 * Canonical, key-sorted serialisation of a tool's input — used as the
 * args portion of the dup-result hash. Same logical input always
 * produces identical bytes regardless of JS engine key-iteration
 * order; that matters because the hash IS the equality predicate for
 * "have I seen this call before".
 *
 * Why not `JSON.stringify` directly: V8 preserves insertion order for
 * non-integer string keys, but model-generated tool args may serialise
 * with different key order across turns (`{path, line}` vs `{line, path}`).
 * Without sorting, semantically identical calls would hash differently
 * and the dup-check would miss legitimate duplicates.
 *
 * Why a hand-rolled walker instead of a dep: ~15 LOC, no transitive
 * surface, output is internal-only (never sent to the model) so
 * prefix-cache stability isn't a concern.
 */
export function stableArgsKey(input: unknown): string {
  if (input === null || input === undefined) return 'null';
  if (typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) {
    return '[' + input.map(stableArgsKey).join(',') + ']';
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => `${JSON.stringify(k)}:${stableArgsKey(obj[k])}`).join(',') +
    '}'
  );
}

/**
 * PR-5 (Row 32 from docs/agent-research/COMPARISON.md): pre-read enforcement.
 * Refuses BEFORE dispatch when a read-family tool (read_file, mcp__read_file,
 * mcp__get_file_skeleton) is called with the SAME
 * path + slice fields seen recently. Tighter than the generic dup-call cap
 * (which fires only on the 5th identical call) and proactive — saves the
 * round-trip the result-dup cap would otherwise burn. Lazy-resolved so tests
 * can override.
 */
export function readDupThreshold(): number {
  const v = process.env.CODER_READ_DUP_THRESHOLD;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2; // refuse on the SECOND identical (path,slice) read
}
export function readDupWindow(): number {
  const v = process.env.CODER_READ_DUP_WINDOW;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 20;
}

/**
 * Auto-downgrade toggle. When enabled, the pre-read guard returns a
 * skeleton-style summary instead of a hard refusal. Default off — refusal
 * with rich payload is more pedagogical and avoids masking the "model is
 * stuck re-reading" signal. Set CODER_READ_AUTO_DOWNGRADE=1 to opt in.
 */
export function readAutoDowngradeEnabled(): boolean {
  return process.env.CODER_READ_AUTO_DOWNGRADE === '1';
}

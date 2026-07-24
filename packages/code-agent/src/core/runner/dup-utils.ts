/**
 * Compact preview of a tool call's input — first 80 chars of the
 * JSON-serialised args, with control chars stripped. Embedded in local
 * invocation-guard reminders so the agent can identify the repeated call.
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
 * args portion of invocation/coalescing keys. Same logical input always
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
 * Read observation threshold. On the Nth same path/slice this enables
 * mutation, context-visibility, and coverage checks. Hybrid/observe still
 * execute a fresh cross-turn read; only the temporary legacy policy may turn
 * the observation into a refusal. Lazy-resolved so tests can override.
 */
export function readDupThreshold(): number {
  const v = process.env.CODER_READ_DUP_THRESHOLD;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2; // observe the second identical (path,slice) read
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
 * Legacy rollback toggle. When enabled under CODER_DEDUP_POLICY=legacy, the
 * pre-read guard returns a skeleton-style pointer instead of a hard refusal.
 */
export function readAutoDowngradeEnabled(): boolean {
  return process.env.CODER_READ_AUTO_DOWNGRADE === '1';
}

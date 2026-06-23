/**
 * Tool-call signature builders used by the doom-loop guards (strict and
 * fuzzy). Pure — same input always produces the same string — so two
 * turns with identical sig values asked the model to do literally the
 * same thing.
 */

/**
 * Deterministic signature of a turn's tool calls. Two turns with the same
 * signature asked the model to do literally the same thing — if that repeats
 * past the threshold, we're looping. Keys in each input object are sorted so
 * cosmetic reordering doesn't mask the repetition.
 */
export function toolCallsSignature(
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
): string {
  if (blocks.length === 0) return '';
  const stable = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  };
  const items = blocks
    .map((b) => `${b.name}:${JSON.stringify(stable(b.input))}`)
    .sort();
  return items.join('|');
}

/**
 * Loose signature: just the sorted tool names. Ignores argument differences
 * so the fuzzy doom-loop guard can catch near-repeats where the model keeps
 * calling the same tools with tweaked arguments without making progress.
 */
export function toolNamesSignature(blocks: Array<{ name: string }>): string {
  if (blocks.length === 0) return '';
  return blocks.map((b) => b.name).sort().join('|');
}

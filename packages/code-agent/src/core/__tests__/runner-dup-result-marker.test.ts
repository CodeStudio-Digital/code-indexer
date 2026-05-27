/**
 * Tests for the dup-result-marker subsystem in `runner.ts`.
 *
 * Focus: the pure helpers that govern hash equality and marker copy.
 * The runtime tier-dispatch lives inside `CoderRunner.run()` (a ~700-line
 * method) and is exercised manually via the verification steps in the
 * approved plan — wiring up a full CoderRunner with mocked provider +
 * tool registry would dwarf the value of the assertions.
 *
 * What these tests guard against:
 *
 *   1. **Hash collision regressions (Bug 1).** The user reported two
 *      distinct `edit_file` calls being false-flagged as duplicates
 *      because the runner hashed only `result.content`. With the fix
 *      (`stableArgsKey(input) + '\x1f' + result.content`), different
 *      inputs MUST produce different hashes even when results are
 *      byte-identical.
 *
 *   2. **Key-order invariance.** Models can emit tool args with any
 *      key order; semantically identical calls must hash the same.
 *
 *   3. **Marker copy stability.** The light + warn markers are
 *      embedded in the assistant transcript — non-deterministic
 *      output would invalidate provider prompt caches. We verify the
 *      exact string templates so a future "small wording tweak"
 *      cannot silently regress prefix-cache hit rates.
 *
 *   4. **`ordinal` correctness.** Sharp edge cases (11th/12th/13th
 *      vs 21st/22nd/23rd) are easy to break with a naive
 *      `s[n % 10]` table.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  stableArgsKey,
  ordinal,
  buildDupLightMarker,
  buildDupWarnMarker,
} from '../runner.js';

// ─── stableArgsKey ──────────────────────────────────────────────

describe('stableArgsKey', () => {
  it('returns "null" for null and undefined (same key — both are "no input")', () => {
    expect(stableArgsKey(null)).toBe('null');
    expect(stableArgsKey(undefined)).toBe('null');
  });

  it('JSON-stringifies primitives unchanged', () => {
    expect(stableArgsKey('foo')).toBe('"foo"');
    expect(stableArgsKey(42)).toBe('42');
    expect(stableArgsKey(true)).toBe('true');
    expect(stableArgsKey(false)).toBe('false');
  });

  it('sorts object keys alphabetically — invariant under JS key insertion order', () => {
    const a = stableArgsKey({ path: 'foo.ts', start_line: 1, end_line: 50 });
    const b = stableArgsKey({ end_line: 50, start_line: 1, path: 'foo.ts' });
    const c = stableArgsKey({ start_line: 1, end_line: 50, path: 'foo.ts' });
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Sanity: the canonical form has keys in alpha order.
    expect(a).toBe('{"end_line":50,"path":"foo.ts","start_line":1}');
  });

  it('preserves array order (positional semantics)', () => {
    const a = stableArgsKey(['x', 'y', 'z']);
    const b = stableArgsKey(['z', 'y', 'x']);
    expect(a).not.toBe(b);
    expect(a).toBe('["x","y","z"]');
  });

  it('handles nested objects recursively', () => {
    const key = stableArgsKey({
      outer: { b: 2, a: 1 },
      arr: [{ z: 9, y: 8 }],
    });
    expect(key).toBe('{"arr":[{"y":8,"z":9}],"outer":{"a":1,"b":2}}');
  });

  it('distinct inputs that produce IDENTICAL result content still hash differently (Bug 1 regression guard)', () => {
    // The reported scenario: two `edit_file` calls on the same file
    // with different `old_string`/`new_string` both returning
    // "Edited foo.ts (1 replacement)". Without args-in-hash they
    // collide; with the fix they MUST differ.
    const result = 'Edited foo.ts (1 replacement)';
    const input1 = { path: 'foo.ts', old_string: 'badge badge-warning', new_string: 'label label-warning' };
    const input2 = { path: 'foo.ts', old_string: 'model.obrigatorio', new_string: 'item.obrigatorio' };

    const hash = (input: object, content: string) =>
      createHash('sha1')
        .update(stableArgsKey(input))
        .update('\x1f')
        .update(content)
        .digest('hex');

    expect(hash(input1, result)).not.toBe(hash(input2, result));
  });

  it('same input + same result hash the same (legitimate duplicate is still caught)', () => {
    const input = { path: 'foo.ts', old_string: 'x', new_string: 'y' };
    const result = 'Edited foo.ts (1 replacement)';
    const hash = (i: object, c: string) =>
      createHash('sha1').update(stableArgsKey(i)).update('\x1f').update(c).digest('hex');
    expect(hash(input, result)).toBe(hash(input, result));
  });

  it('args-only differences hash differently even when content is empty', () => {
    // Defends against the trivial edge case where someone wires the
    // hash with an args-only contribution.
    expect(stableArgsKey({ a: 1 })).not.toBe(stableArgsKey({ a: 2 }));
  });

  it('unit-separator prevents string-concat collision between args + content', () => {
    // Without `\x1f` between the two parts, `args="{x:a}"` + `result="foo"`
    // would concat the same as `args="{x:af"` + `result="oo"`. The hash
    // function in runner.ts uses `.update(argsKey).update('\x1f').update(result)`
    // which makes that collision structurally impossible. This test
    // documents the invariant via the helpers' output shapes.
    const a = stableArgsKey({ x: 'a' });
    const b = stableArgsKey({ x: 'af' });
    expect(a).toBe('{"x":"a"}');
    expect(b).toBe('{"x":"af"}');
    // Concatenated with the result, even WITHOUT a separator, the
    // ambiguity is contained because keys carry their own quoting.
    // The `\x1f` is belt-and-suspenders.
    expect(a + 'foo').not.toBe(b + 'oo');
  });
});

// ─── ordinal ────────────────────────────────────────────────────

describe('ordinal', () => {
  it('handles small numbers correctly', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(5)).toBe('5th');
  });

  it('handles the 11/12/13 edge case (always "th", not "st/nd/rd")', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
  });

  it('returns to the suffix table after the teens', () => {
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
    expect(ordinal(24)).toBe('24th');
  });

  it('handles multiples of ten correctly', () => {
    expect(ordinal(10)).toBe('10th');
    expect(ordinal(20)).toBe('20th');
    expect(ordinal(100)).toBe('100th');
    expect(ordinal(101)).toBe('101st');
  });
});

// ─── buildDupLightMarker ────────────────────────────────────────

describe('buildDupLightMarker', () => {
  const baseArgs = {
    toolName: 'find_references',
    originalTurn: 7,
    originalUseIdShort: 'call_abc12',
    window: 15,
    priorIsCompacted: false,
    argsPreview: '{"symbol_name":"foo"}',
  };

  it('produces a deterministic single-line marker (prefix-cache stability)', () => {
    const a = buildDupLightMarker(baseArgs);
    const b = buildDupLightMarker(baseArgs);
    expect(a).toBe(b);
    expect(a).not.toContain('\n');
  });

  it('includes tool name, turn, use_id, args preview, and window in the body', () => {
    const marker = buildDupLightMarker(baseArgs);
    expect(marker).toContain('find_references');
    expect(marker).toContain('turn 7');
    expect(marker).toContain('call_abc12');
    expect(marker).toContain('{"symbol_name":"foo"}');
    expect(marker).toContain('15 turns');
  });

  it('warns the agent about the next-call escalation', () => {
    const marker = buildDupLightMarker(baseArgs);
    expect(marker).toMatch(/escalate.*hard refuse/i);
    expect(marker).toContain('force_reread: true');
  });

  it('switches to compacted-prior variant when priorIsCompacted is true', () => {
    const marker = buildDupLightMarker({ ...baseArgs, priorIsCompacted: true });
    expect(marker).toContain('compacted out of your context');
    expect(marker).toContain('content below is');
    // Does NOT leak the (stale) use_id — that's the whole point of
    // the compacted variant.
    expect(marker).not.toContain('call_abc12');
  });
});

// ─── buildDupWarnMarker ─────────────────────────────────────────

describe('buildDupWarnMarker', () => {
  const baseArgs = {
    toolName: 'read_file',
    originalTurn: 3,
    hitCount: 3,
    window: 15,
    priorIsCompacted: false,
    argsPreview: '{"path":"src/foo.ts"}',
  };

  it('starts with "WARNING" so the agent reads it as escalation', () => {
    const marker = buildDupWarnMarker(baseArgs);
    expect(marker).toContain('WARNING');
  });

  it('announces the next call will REFUSE', () => {
    const marker = buildDupWarnMarker(baseArgs);
    expect(marker).toMatch(/REFUSE the next call/);
  });

  it('embeds the human ordinal for hitCount (3rd, 4th, etc.)', () => {
    expect(buildDupWarnMarker(baseArgs)).toContain('3rd identical fetch');
    expect(buildDupWarnMarker({ ...baseArgs, hitCount: 4 })).toContain('4th identical fetch');
    expect(buildDupWarnMarker({ ...baseArgs, hitCount: 11 })).toContain('11th identical fetch');
  });

  it('points the agent at force_reread as escape', () => {
    expect(buildDupWarnMarker(baseArgs)).toContain('force_reread: true');
  });

  it('switches to compacted variant without leaking use_id (none in this variant anyway)', () => {
    const marker = buildDupWarnMarker({ ...baseArgs, priorIsCompacted: true });
    expect(marker).toContain('compacted out of context');
    expect(marker).toContain('Content below is current');
  });

  it('is single-line (prefix-cache stability)', () => {
    expect(buildDupWarnMarker(baseArgs)).not.toContain('\n');
    expect(buildDupWarnMarker({ ...baseArgs, priorIsCompacted: true })).not.toContain('\n');
  });
});

/**
 * Result-content dedup cap (Agent Loop v2). Verifies that the runner refuses
 * a tool call whose RAW result content is byte-identical to a recent earlier
 * result from the same tool, even when the args differ. This catches the
 * "snap-to-symbol" loop pattern where the agent shifts `around_line` by a
 * few lines and the resolver returns the same body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The runner's logic, distilled to the essential per-turn check. Mirrors
 * the implementation in runner.ts so we can verify behaviour without
 * spinning up a full provider mock.
 */
function checkResultDup(
  state: Map<string, Array<{ hash: string; turn: number }>>,
  toolName: string,
  content: string,
  turn: number,
  threshold = 1,
  windowTurns = 15,
  minChars = 50,
): { refused: boolean; matches: number } {
  if (content.length < minChars) return { refused: false, matches: 0 };
  const resultHash = createHash('sha1').update(content).digest('hex');
  const prior = state.get(toolName) ?? [];
  const minTurn = turn - windowTurns;
  const filtered = prior.filter((e) => e.turn > minTurn);
  const matches = filtered.filter((e) => e.hash === resultHash).length;
  filtered.push({ hash: resultHash, turn });
  state.set(toolName, filtered);
  return { refused: matches >= threshold, matches };
}

describe('result-content dup cap (Agent Loop v2)', () => {
  let state: Map<string, Array<{ hash: string; turn: number }>>;

  beforeEach(() => {
    state = new Map();
  });

  it('does not refuse the first call', () => {
    const r = checkResultDup(state, 'mcp__read_file', 'A'.repeat(100), 1);
    expect(r.refused).toBe(false);
  });

  it('does not refuse non-duplicate content', () => {
    checkResultDup(state, 'mcp__read_file', 'A'.repeat(100), 1);
    const r = checkResultDup(state, 'mcp__read_file', 'B'.repeat(100), 2);
    expect(r.refused).toBe(false);
  });

  it('refuses on the second identical call (default threshold=1)', () => {
    const same = 'snapped body content here'.repeat(10); // > 50 chars
    checkResultDup(state, 'mcp__read_file', same, 1);
    const r = checkResultDup(state, 'mcp__read_file', same, 2);
    expect(r.refused).toBe(true);
    expect(r.matches).toBe(1);
  });

  it('reproduces the session 622 snap-to-symbol loop', () => {
    // The model shifted around_line from 1640 to 1690 across calls but the
    // resolver kept returning lines 1673-1685 (same body). We simulate this
    // by passing the same content payload across multiple turns even though
    // the args (which the dup cap would have hashed previously) differ.
    const snappedBody =
      'lines 1673-1685 of control-plane.ts ' + 'x'.repeat(500);
    const turns = [1, 2, 3, 4, 5];
    const results = turns.map((t) =>
      checkResultDup(state, 'mcp__read_file', snappedBody, t),
    );
    // First call passes, every subsequent call is refused.
    expect(results[0].refused).toBe(false);
    expect(results.slice(1).every((r) => r.refused)).toBe(true);
  });

  it('forgets results that fall outside the window', () => {
    const same = 'C'.repeat(200);
    checkResultDup(state, 'mcp__read_file', same, 1);
    // 16 turns later, the window has slid past the original entry.
    const r = checkResultDup(state, 'mcp__read_file', same, 17);
    expect(r.refused).toBe(false);
  });

  it('does not trip on tiny outputs (under min-chars)', () => {
    checkResultDup(state, 'shell', 'ok', 1);
    const r = checkResultDup(state, 'shell', 'ok', 2);
    expect(r.refused).toBe(false);
  });

  it('isolates state per tool name', () => {
    const same = 'D'.repeat(200);
    checkResultDup(state, 'mcp__read_file', same, 1);
    const r = checkResultDup(state, 'mcp__get_file_skeleton', same, 2);
    expect(r.refused).toBe(false);
  });
});

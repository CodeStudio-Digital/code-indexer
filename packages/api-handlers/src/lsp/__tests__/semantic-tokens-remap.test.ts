/**
 * Pure tests for the semantic-token legend remapper — the riskiest bit, since
 * dropping a token from a delta-encoded stream means the gaps it left must fold
 * into the next surviving token or every position downstream shifts.
 */
import { describe, it, expect } from 'vitest';
import {
  remapSemanticTokens,
  MONACO_SEMANTIC_LEGEND,
  type SemanticTokensLegend,
} from '../semantic-tokens-remap.js';

// A representative server legend mixing types Monaco keeps (class/function/…)
// with types it drops (comment/keyword/string/number), in a different order +
// a different modifier ordering than Monaco's.
const SERVER: SemanticTokensLegend = {
  tokenTypes: [
    'comment', 'keyword', 'string', 'number', // 0..3 → dropped
    'class', 'function', 'method', 'property', 'variable', 'parameter', // 4..9 → kept
    'struct', 'event', 'member', // 10..12 → C# types kept
  ],
  tokenModifiers: ['declaration', 'readonly', 'static', 'deprecated', 'defaultLibrary'],
};

// Resolved target indices, for readable expectations.
const T = (name: string) => MONACO_SEMANTIC_LEGEND.tokenTypes.indexOf(name);

describe('remapSemanticTokens', () => {
  it('returns [] for empty input', () => {
    expect(remapSemanticTokens([], SERVER)).toEqual([]);
  });

  it('remaps a single kept token type index', () => {
    // line +2, char 4, len 6, type 5 (function), no mods
    expect(remapSemanticTokens([2, 4, 6, 5, 0], SERVER)).toEqual([2, 4, 6, T('function'), 0]);
  });

  it('preserves C#-specific semantic classifications', () => {
    expect(remapSemanticTokens([
      0, 0, 6, 10, 0,
      0, 7, 5, 11, 0,
      0, 6, 4, 12, 0,
    ], SERVER)).toEqual([
      0, 0, 6, T('struct'), 0,
      0, 7, 5, T('event'), 0,
      0, 6, 4, T('member'), 0,
    ]);
  });

  it('drops an unrepresentable type and folds its char offset into the next token', () => {
    // T0 @ (0,2) comment → drop;  T1 +5 char → abs (0,7) function → keep.
    // The dropped token sat at char 2, so T1's emitted delta is 2+5 = 7 from line start.
    expect(remapSemanticTokens([0, 2, 3, 0, 0, /**/ 0, 5, 4, 5, 0], SERVER))
      .toEqual([0, 7, 4, T('function'), 0]);
  });

  it('folds a dropped middle token between two kept tokens', () => {
    // T0 (0,0) function keep → [0,0,2]; T1 (0,4) keyword drop; T2 (0,7) method keep.
    // T2 must be 7 from the last EMITTED token (T0 @ char 0), not 3 from the dropped T1.
    const data = [0, 0, 2, 5, 0, /**/ 0, 4, 3, 1, 0, /**/ 0, 3, 2, 6, 0];
    expect(remapSemanticTokens(data, SERVER)).toEqual([
      0, 0, 2, T('function'), 0,
      0, 7, 2, T('method'), 0,
    ]);
  });

  it('remaps the modifier bitset across differing orderings', () => {
    // type 7 (property) with readonly(bit1)+static(bit2) → server bits 0b110 = 6.
    // readonly→idx3, static→idx1 in Monaco modifiers → 0b1000 | 0b0010 = 10.
    expect(remapSemanticTokens([1, 0, 5, 7, 6], SERVER)).toEqual([1, 0, 5, T('property'), 10]);
  });

  it('drops a server modifier absent from the target legend', () => {
    // deprecated(bit3) is not in Monaco's modifiers → contributes nothing.
    expect(remapSemanticTokens([0, 0, 4, 8, 0b1000], SERVER)).toEqual([0, 0, 4, T('variable'), 0]);
  });

  it('preserves multiline deltas relative to the last emitted token', () => {
    // T0 (0,0) function; drop nothing; T1 +2 lines, char 3, method.
    const data = [0, 0, 4, 5, 0, /**/ 2, 3, 6, 6, 0];
    expect(remapSemanticTokens(data, SERVER)).toEqual([
      0, 0, 4, T('function'), 0,
      2, 3, 6, T('method'), 0,
    ]);
  });

  it('drops tokens whose type index is out of legend range', () => {
    expect(remapSemanticTokens([0, 0, 1, 99, 0], SERVER)).toEqual([]);
  });

  it('ignores a trailing partial tuple', () => {
    // 6 numbers = one full token + a stray pair; the stray is ignored.
    expect(remapSemanticTokens([0, 0, 3, 5, 0, 7], SERVER)).toEqual([0, 0, 3, T('function'), 0]);
  });
});

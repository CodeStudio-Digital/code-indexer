/**
 * Remap LSP semantic tokens from a language server's OWN legend onto Monaco's
 * fixed legend (the one the renderer declares in
 * `apps/dashboard/features/workspace/editor/lsp/navigation.ts`).
 *
 * Why this exists: intelephense/pyright/etc. each pick their own ordering for
 * `tokenTypes`/`tokenModifiers` and advertise it via `semanticTokensProvider.
 * legend` at init. Monaco, on the other hand, decodes the token stream against
 * the single legend our `registerDocumentSemanticTokensProvider` returns. So a
 * server's type index `5` is meaningless to Monaco unless we translate it to
 * the index of the SAME type name in Monaco's legend.
 *
 * Token types the Monaco legend doesn't carry (keyword, string, number,
 * comment, operator, …) are DROPPED — the Monarch tokenizer already colours
 * those well, and forwarding them would require Monaco to know them. Because
 * the wire format is delta-encoded (each token positioned relative to the
 * previous one), dropping a token can't just splice it out: we decode to
 * absolute positions, skip the dropped ones, then re-encode deltas relative to
 * the last token we actually EMITTED.
 *
 * Pure + synchronous → unit-tested directly (see __tests__).
 */

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/**
 * Monaco's canonical semantic-token legend. MUST stay identical to
 * `SEMANTIC_TOKEN_LEGEND` in the renderer's `lsp/navigation.ts` — the renderer
 * decodes the stream we emit against it. These are the classifications that let
 * a theme paint "function ≠ method ≠ property ≠ parameter ≠ class" differently.
 */
export const MONACO_SEMANTIC_LEGEND: SemanticTokensLegend = {
  tokenTypes: [
    'class', 'enum', 'interface', 'namespace', 'typeParameter',
    'type', 'parameter', 'variable', 'enumMember', 'property',
    'function', 'method', 'struct', 'event', 'member',
  ],
  tokenModifiers: [
    'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local',
  ],
};

/**
 * Translate a server-encoded semantic-token stream onto `targetLegend`,
 * dropping token types absent from the target. Input/output are flat arrays of
 * 5-tuples `[deltaLine, deltaStartChar, length, tokenType, tokenModifiers]`.
 */
export function remapSemanticTokens(
  data: readonly number[],
  serverLegend: SemanticTokensLegend,
  targetLegend: SemanticTokensLegend = MONACO_SEMANTIC_LEGEND,
): number[] {
  // server type/modifier index → target index (-1 = not representable → drop).
  const typeMap = serverLegend.tokenTypes.map((name) => targetLegend.tokenTypes.indexOf(name));
  const modMap = serverLegend.tokenModifiers.map((name) => targetLegend.tokenModifiers.indexOf(name));

  const out: number[] = [];
  // absolute position of the token currently being read…
  let line = 0;
  let char = 0;
  // …and of the last token we actually emitted (for re-deltaing).
  let emittedLine = 0;
  let emittedChar = 0;

  for (let i = 0; i + 5 <= data.length; i += 5) {
    const dLine = data[i];
    const dChar = data[i + 1];
    const len = data[i + 2];
    const typeIdx = data[i + 3];
    const modBits = data[i + 4];

    // Advance the absolute cursor whether or not we keep the token.
    if (dLine > 0) {
      line += dLine;
      char = dChar;
    } else {
      char += dChar;
    }

    const mappedType = typeIdx >= 0 && typeIdx < typeMap.length ? typeMap[typeIdx] : -1;
    if (mappedType < 0) continue; // unknown/unwanted type → drop (cursor already moved)

    // Remap the modifier bitset bit-by-bit (orderings differ between legends).
    let mappedMods = 0;
    if (modBits) {
      for (let bit = 0; bit < modMap.length; bit++) {
        if ((modBits & (1 << bit)) !== 0) {
          const target = modMap[bit];
          if (target >= 0) mappedMods |= 1 << target;
        }
      }
    }

    // Re-delta relative to the previous EMITTED token, not the previous read one.
    const outDLine = line - emittedLine;
    const outDChar = outDLine === 0 ? char - emittedChar : char;
    out.push(outDLine, outDChar, len, mappedType, mappedMods);
    emittedLine = line;
    emittedChar = char;
  }

  return out;
}

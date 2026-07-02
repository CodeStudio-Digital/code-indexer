/**
 * Post-processing v2 — scrubs raw model output into insert-ready ghost text.
 * Supersedes completion-prompt.ts's postProcessCompletion with token-boundary
 * aware cuts plus rejection of degenerate outputs (line-above rewrites,
 * repetition loops). Pure string work, no IO.
 *
 * Pipeline order matters:
 *   normalize → strip thinking → strip fences → cut prefix echo →
 *   reject line-above rewrite → single-line cut → repetition guard →
 *   cut suffix overlap → bracket guard → cleanup
 */

const IDENT = /[A-Za-z0-9_$]/;

/** Strip a single wrapping markdown fence, keeping the inner code. */
function stripFences(text: string): string {
  const m = text.match(/^\s*```[\w-]*\r?\n([\s\S]*?)(\r?\n```\s*)?$/);
  return m ? (m[1] ?? '') : text;
}

/**
 * Drop inline reasoning from thinking models (`<think>…</think>` INSIDE
 * content). Unterminated block = the token budget died mid-reasoning.
 */
function stripThinking(text: string): string {
  const cut = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return /<think>/i.test(cut) ? '' : cut;
}

/**
 * Longest tail-of-prefix that the output re-types (≥3 chars), cut ONLY at a
 * clean token boundary: the overlap's last char or the remainder's first
 * char must be a non-identifier. Protects `foo` + `foobar()` (both idents →
 * no cut) while still cutting `const total = ` echoes (ends in space).
 */
function cutPrefixEcho(text: string, prefix: string): string {
  const tail = prefix.slice(-200);
  for (let len = Math.min(tail.length, text.length); len >= 3; len--) {
    if (!text.startsWith(tail.slice(tail.length - len))) continue;
    const overlapEnd = text[len - 1]!;
    const remainderStart = text[len];
    if (remainderStart === undefined || !IDENT.test(remainderStart) || !IDENT.test(overlapEnd)) {
      return text.slice(len);
    }
    // Boundary splits a token — a shorter overlap can still be clean.
  }
  return text;
}

/** 2·(common prefix+suffix)/(len a+b) on trimmed lines — cheap similarity. */
function lineSimilarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  return (2 * (pre + suf)) / (x.length + y.length);
}

/** The model re-writing the line above the cursor is never insertable. */
function rewritesLineAbove(text: string, prefix: string): boolean {
  const firstLine = text.split('\n').find((l) => l.trim() !== '');
  if (!firstLine) return false;
  const prefixLines = prefix.split('\n');
  // Last non-empty line ABOVE the cursor line (the cursor line's text is a
  // legitimate continuation target, not a rewrite).
  let lineAbove = '';
  for (let i = prefixLines.length - 2; i >= 0; i--) {
    if (prefixLines[i]!.trim() !== '') { lineAbove = prefixLines[i]!; break; }
  }
  return lineAbove !== '' && lineSimilarity(firstLine, lineAbove) > 0.8;
}

/**
 * Loop/repetition guard:
 *  (a) any non-trivial line occurring >4× → truncate at its 3rd occurrence;
 *  (b) 3 consecutive identical lines → truncate at the 2nd;
 *  (c) a ≥3-line completion whose lines exist verbatim in the recent prefix
 *      (>80%) is a re-type, not a completion → reject.
 */
function repetitionGuard(text: string, prefix: string): string {
  const lines = text.split('\n');
  const counts = new Map<string, number>();
  let consecutive = 1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length < 3) { consecutive = 1; continue; }
    const n = (counts.get(t) ?? 0) + 1;
    counts.set(t, n);
    if (n > 4) return lines.slice(0, i).join('\n');
    consecutive = i > 0 && lines[i - 1]!.trim() === t ? consecutive + 1 : 1;
    if (consecutive >= 3) return lines.slice(0, i - 1).join('\n');
  }
  const meaningful = lines.map((l) => l.trim()).filter((l) => l.length > 2);
  if (meaningful.length >= 3) {
    const recent = new Set(prefix.split('\n').slice(-12).map((l) => l.trim()));
    const dup = meaningful.filter((l) => recent.has(l)).length;
    if (dup / meaningful.length > 0.8) return '';
  }
  return text;
}

/**
 * Drop the re-typed suffix head (closing brackets etc. already in the
 * buffer), only when the cut point is a clean token boundary — fixes the
 * `items->count` + suffix `count()` case (cut at `->`) without mangling
 * identifiers.
 */
function cutSuffixOverlap(text: string, suffix: string): string {
  const head = suffix.slice(0, 80);
  for (let len = Math.min(head.length, text.length); len >= 2; len--) {
    const candidate = head.slice(0, len);
    if (candidate.trim().length === 0 || !text.endsWith(candidate)) continue;
    const beforeCut = text[text.length - len - 1];
    if (beforeCut === undefined || !IDENT.test(beforeCut) || !IDENT.test(candidate[0]!)) {
      return text.slice(0, text.length - len);
    }
  }
  return text;
}

/**
 * Bracket guard: closers dangling at the END of the completion that the
 * suffix already provides (with whitespace in between, so the literal
 * suffix-overlap cut missed them) are dropped pairwise. Only unmatched
 * closers are candidates — balanced text is never touched.
 */
function bracketGuard(text: string, suffix: string): string {
  const OPEN: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let out = text;
  let rest = suffix.replace(/^\s+/, '');
  for (;;) {
    const trimmed = out.trimEnd();
    const last = trimmed.slice(-1);
    if (!(last in OPEN) || rest.slice(0, 1) !== last) break;
    // Unmatched within the completion? Scan a depth counter.
    let depth = 0;
    for (const ch of trimmed) {
      if (ch === OPEN[last]) depth++;
      else if (ch === last) depth--;
    }
    if (depth >= 0) break; // balanced (or over-opened) — keep it
    out = trimmed.slice(0, -1);
    rest = rest.slice(1).replace(/^\s+/, '');
  }
  return out;
}

/**
 * Scrub raw model output into insert-ready ghost text. Returns '' when
 * nothing insertable remains.
 */
export function postProcessV2(
  raw: string,
  ctx: { prefix: string; suffix: string; multiline: boolean },
): string {
  let text = stripFences(stripThinking(raw.replace(/\r\n/g, '\n')));
  // Code followed by a fence + prose ("…\n``` Explanation:") — keep the code.
  const trailingFence = text.indexOf('\n```');
  if (trailingFence >= 0) text = text.slice(0, trailingFence);
  text = text.split('<CURSOR>').join('');

  text = cutPrefixEcho(text, ctx.prefix);
  if (rewritesLineAbove(text, ctx.prefix)) return '';

  if (!ctx.multiline) {
    text = text.split('\n')[0] ?? '';
  } else {
    text = repetitionGuard(text, ctx.prefix);
  }

  text = cutSuffixOverlap(text, ctx.suffix);
  text = bracketGuard(text, ctx.suffix);

  // Drop trailing whitespace-only lines (stop sequences leave half-cuts).
  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, (m) => (m.length > 1 ? '\n' : ''));
  return text.trim().length === 0 ? '' : text;
}

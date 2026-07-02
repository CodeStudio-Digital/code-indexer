/**
 * Server-side multiline decision (Continue's shouldCompleteMultiline
 * adapted). `multiline: 'auto'` (the new default) picks per position:
 * mid-line or inside a comment → single line; a fresh line or a line ending
 * in a block/expression opener → multiline. Legacy `true`/`false` bindings
 * keep their exact old behavior.
 */

/** Line endings that invite a multi-line continuation. */
const OPENER_RE = /(?:\{|\(|\[|,|:|=>|->|=|&&|\|\||\?)$/;
const BLOCK_KEYWORD_RE = /\b(?:try|do|else|then|begin|return)$/;
const COMMENT_LINE_RE = /^\s*(?:\/\/|#|--|\*|\/\*)/;

export function decideMultiline(
  cfgMultiline: boolean | 'auto' | undefined,
  prefix: string,
  suffix: string,
  _languageId: string,
): boolean {
  if (cfgMultiline === true || cfgMultiline === false) return cfgMultiline;

  const curLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const nl = suffix.indexOf('\n');
  const restOfLine = nl < 0 ? suffix : suffix.slice(0, nl);

  // Mid-line/mid-expression: complete just the line.
  if (restOfLine.trim() !== '') return false;
  // Comment lines get single-line continuations.
  if (COMMENT_LINE_RE.test(curLine)) return false;
  // Fresh line → full block allowed.
  const trimmed = curLine.trimEnd();
  if (trimmed === '') return true;
  // Line ends in an opener or block keyword → the model may open a block.
  if (OPENER_RE.test(trimmed) || BLOCK_KEYWORD_RE.test(trimmed)) return true;
  // Otherwise finish the current statement only.
  return false;
}

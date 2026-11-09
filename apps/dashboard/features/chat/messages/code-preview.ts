const MAX_PREVIEW_LINES = 24;
const MAX_PREVIEW_CHARS = 3_500;

/** Only inspect the visible prefix; a collapsed fence must not allocate every
 * line or syntax-token DOM node from a large, hidden tool/code response. */
export function codePreview(code: string): { text: string; truncated: boolean } {
  let end = Math.min(code.length, MAX_PREVIEW_CHARS);
  let lines = 1;
  for (let index = 0; index < end; index++) {
    if (code.charCodeAt(index) === 10 && ++lines > MAX_PREVIEW_LINES) {
      end = index;
      break;
    }
  }
  // Avoid splitting a UTF-16 surrogate pair at the character budget.
  const last = code.charCodeAt(end - 1);
  if (end < code.length && last >= 0xd800 && last <= 0xdbff) end--;
  return { text: code.slice(0, end), truncated: end < code.length };
}

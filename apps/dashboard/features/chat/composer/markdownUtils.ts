// Pure text manipulation functions for markdown editing.
// Every function takes (text, selStart, selEnd) and returns a TextEditResult.

export interface TextEditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function getLineRange(text: string, pos: number) {
  let lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd, lineText: text.slice(lineStart, lineEnd) };
}

function getSelectedLines(text: string, selStart: number, selEnd: number) {
  const lines: { lineStart: number; lineEnd: number; lineText: string }[] = [];
  let lineStart = text.lastIndexOf('\n', selStart - 1) + 1;
  while (lineStart <= selEnd) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    lines.push({ lineStart, lineEnd, lineText: text.slice(lineStart, lineEnd) });
    if (lineEnd >= text.length) break;
    lineStart = lineEnd + 1;
  }
  return lines;
}

// ── Inline wrapping ────────────────────────────────────────────────────

function wrapSelection(
  text: string,
  selStart: number,
  selEnd: number,
  wrapper: string,
): TextEditResult {
  const wl = wrapper.length;

  if (selStart !== selEnd) {
    // Has selection — check if already wrapped
    const selected = text.slice(selStart, selEnd);
    // Case 1: selection itself contains the wrapper on both sides
    if (selected.startsWith(wrapper) && selected.endsWith(wrapper) && selected.length >= wl * 2) {
      const unwrapped = selected.slice(wl, -wl);
      return {
        text: text.slice(0, selStart) + unwrapped + text.slice(selEnd),
        selStart,
        selEnd: selStart + unwrapped.length,
      };
    }
    // Case 2: wrapper is outside the selection
    if (
      selStart >= wl &&
      text.slice(selStart - wl, selStart) === wrapper &&
      text.slice(selEnd, selEnd + wl) === wrapper
    ) {
      return {
        text: text.slice(0, selStart - wl) + text.slice(selStart, selEnd) + text.slice(selEnd + wl),
        selStart: selStart - wl,
        selEnd: selEnd - wl,
      };
    }
    // Wrap
    return {
      text: text.slice(0, selStart) + wrapper + selected + wrapper + text.slice(selEnd),
      selStart: selStart + wl,
      selEnd: selEnd + wl,
    };
  }

  // No selection — check if cursor is inside an existing wrapper pair
  if (
    selStart >= wl &&
    text.slice(selStart - wl, selStart) === wrapper &&
    text.slice(selStart, selStart + wl) === wrapper
  ) {
    // Remove the empty wrapper pair
    return {
      text: text.slice(0, selStart - wl) + text.slice(selStart + wl),
      selStart: selStart - wl,
      selEnd: selStart - wl,
    };
  }

  // Insert empty wrapper pair, cursor in the middle
  return {
    text: text.slice(0, selStart) + wrapper + wrapper + text.slice(selStart),
    selStart: selStart + wl,
    selEnd: selStart + wl,
  };
}

export function toggleBold(text: string, s: number, e: number) {
  return wrapSelection(text, s, e, '**');
}
export function toggleItalic(text: string, s: number, e: number) {
  return wrapSelection(text, s, e, '*');
}
export function toggleStrikethrough(text: string, s: number, e: number) {
  return wrapSelection(text, s, e, '~~');
}
export function toggleInlineCode(text: string, s: number, e: number) {
  return wrapSelection(text, s, e, '`');
}

// ── Block-level prefix ─────────────────────────────────────────────────

function toggleLinePrefix(
  text: string,
  selStart: number,
  selEnd: number,
  prefix: string,
): TextEditResult {
  const lines = getSelectedLines(text, selStart, selEnd);
  let delta = 0;
  let newText = text;

  for (let i = lines.length - 1; i >= 0; i--) {
    const { lineStart, lineText } = lines[i];
    const trimmed = lineText.replace(/^(\s*)/, '');
    const indent = lineText.length - trimmed.length;

    if (trimmed.startsWith(prefix)) {
      // Remove prefix
      const removeStart = lineStart + indent;
      newText = newText.slice(0, removeStart) + newText.slice(removeStart + prefix.length);
      if (lineStart + indent < selStart) delta -= prefix.length;
    } else {
      // Add prefix
      const insertPos = lineStart + indent;
      newText = newText.slice(0, insertPos) + prefix + newText.slice(insertPos);
      if (lineStart + indent < selStart) delta += prefix.length;
    }
  }

  return {
    text: newText,
    selStart: Math.max(0, selStart + delta),
    selEnd: selEnd + (newText.length - text.length),
  };
}

export function toggleHeading(text: string, selStart: number, selEnd: number): TextEditResult {
  const { lineStart, lineText } = getLineRange(text, selStart);
  const h3 = /^### /;
  const h2 = /^## /;

  if (h3.test(lineText)) {
    // Remove heading
    const newText = text.slice(0, lineStart) + lineText.slice(4) + text.slice(lineStart + lineText.length);
    return { text: newText, selStart: selStart - 4, selEnd: selEnd - 4 };
  }
  if (h2.test(lineText)) {
    // Upgrade to h3
    const newText = text.slice(0, lineStart) + '### ' + lineText.slice(3) + text.slice(lineStart + lineText.length);
    return { text: newText, selStart: selStart + 1, selEnd: selEnd + 1 };
  }
  // Add h2
  const newText = text.slice(0, lineStart) + '## ' + lineText + text.slice(lineStart + lineText.length);
  return { text: newText, selStart: selStart + 3, selEnd: selEnd + 3 };
}

export function toggleUnorderedList(text: string, s: number, e: number) {
  return toggleLinePrefix(text, s, e, '- ');
}

export function toggleOrderedList(
  text: string,
  selStart: number,
  selEnd: number,
): TextEditResult {
  const lines = getSelectedLines(text, selStart, selEnd);
  const allOrdered = lines.every(({ lineText }) => /^\s*\d+\.\s/.test(lineText));

  if (allOrdered) {
    // Remove ordered list prefixes
    let newText = text;
    let delta = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const { lineStart, lineText } = lines[i];
      const match = lineText.match(/^(\s*)\d+\.\s/);
      if (match) {
        const prefixLen = match[0].length - (match[1]?.length ?? 0);
        const removeStart = lineStart + (match[1]?.length ?? 0);
        newText = newText.slice(0, removeStart) + newText.slice(removeStart + prefixLen);
        if (removeStart < selStart) delta -= prefixLen;
      }
    }
    return { text: newText, selStart: Math.max(0, selStart + delta), selEnd: selEnd + (newText.length - text.length) };
  }

  // Add ordered list prefixes
  let newText = text;
  let delta = 0;
  let num = 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const { lineStart, lineText } = lines[i];
    const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
    const content = lineText.slice(indent.length);
    // Remove any existing list prefix
    const clean = content.replace(/^[-*+]\s|^\d+\.\s|^- \[[ x]\]\s/i, '');
    const numbered = `${lines.length - i}. ${clean}`;
    newText = newText.slice(0, lineStart + indent.length) + numbered + newText.slice(lineStart + lineText.length);
  }
  // Recalculate with forward pass for correct numbers
  const resultLines = getSelectedLines(newText, 0, newText.length);
  // Simple approach: just rebuild from the selection range
  const finalLines = getSelectedLines(text, selStart, selEnd);
  let result = text;
  let offset = 0;
  for (let i = 0; i < finalLines.length; i++) {
    const { lineStart, lineText } = finalLines[i];
    const indent = lineText.match(/^(\s*)/)?.[1] ?? '';
    const content = lineText.slice(indent.length).replace(/^[-*+]\s|^\d+\.\s|^- \[[ x]\]\s/i, '');
    const prefix = `${i + 1}. `;
    const replacement = indent + prefix + content;
    const adjustedStart = lineStart + offset;
    result = result.slice(0, adjustedStart) + replacement + result.slice(adjustedStart + lineText.length);
    if (i === 0) delta = replacement.length - lineText.length;
    offset += replacement.length - lineText.length;
  }

  return {
    text: result,
    selStart: selStart + delta,
    selEnd: selEnd + offset,
  };
}

export function toggleTaskList(text: string, s: number, e: number) {
  return toggleLinePrefix(text, s, e, '- [ ] ');
}

export function toggleBlockquote(text: string, s: number, e: number) {
  return toggleLinePrefix(text, s, e, '> ');
}

// ── Code block ─────────────────────────────────────────────────────────

export function toggleCodeBlock(
  text: string,
  selStart: number,
  selEnd: number,
): TextEditResult {
  if (selStart !== selEnd) {
    const selected = text.slice(selStart, selEnd);
    // Check if already in code block (selection starts/ends with ```)
    if (selected.startsWith('```\n') && selected.endsWith('\n```')) {
      const inner = selected.slice(4, -4);
      return {
        text: text.slice(0, selStart) + inner + text.slice(selEnd),
        selStart,
        selEnd: selStart + inner.length,
      };
    }
    const wrapped = '```\n' + selected + '\n```';
    return {
      text: text.slice(0, selStart) + wrapped + text.slice(selEnd),
      selStart: selStart + 4,
      selEnd: selStart + 4 + selected.length,
    };
  }

  // No selection — insert template
  const fence = '```\n\n```';
  return {
    text: text.slice(0, selStart) + fence + text.slice(selStart),
    selStart: selStart + 4, // cursor between the fences
    selEnd: selStart + 4,
  };
}

// ── Link ───────────────────────────────────────────────────────────────

export function insertLink(
  text: string,
  selStart: number,
  selEnd: number,
): TextEditResult {
  if (selStart !== selEnd) {
    const selected = text.slice(selStart, selEnd);
    const linked = `[${selected}](url)`;
    return {
      text: text.slice(0, selStart) + linked + text.slice(selEnd),
      // Select "url" so user can type the link
      selStart: selStart + selected.length + 3,
      selEnd: selStart + selected.length + 6,
    };
  }
  const tpl = '[text](url)';
  return {
    text: text.slice(0, selStart) + tpl + text.slice(selStart),
    // Select "text" so user can type the label
    selStart: selStart + 1,
    selEnd: selStart + 5,
  };
}

// ── Horizontal rule ────────────────────────────────────────────────────

export function insertHorizontalRule(
  text: string,
  selStart: number,
  _selEnd: number,
): TextEditResult {
  const { lineStart, lineText } = getLineRange(text, selStart);
  const needsLeadingNewline = lineText.length > 0;
  const hr = (needsLeadingNewline ? '\n' : '') + '---\n';
  const insertPos = lineStart + lineText.length;
  return {
    text: text.slice(0, insertPos) + hr + text.slice(insertPos),
    selStart: insertPos + hr.length,
    selEnd: insertPos + hr.length,
  };
}

// ── Smart list continuation ────────────────────────────────────────────

const LIST_PATTERN = /^(\s*)([-*+]|\d+\.)\s(\[[ x]\]\s)?/;

export function handleListContinuation(
  text: string,
  selStart: number,
): TextEditResult | null {
  const { lineStart, lineText } = getLineRange(text, selStart);
  const match = lineText.match(LIST_PATTERN);
  if (!match) return null;

  const [fullMatch, indent, bullet, checkbox] = match;
  const contentAfterPrefix = lineText.slice(fullMatch.length);

  // If the line is just the prefix (empty content), remove it — exit list mode
  if (contentAfterPrefix.trim() === '') {
    return {
      text: text.slice(0, lineStart) + '\n' + text.slice(lineStart + lineText.length),
      selStart: lineStart + 1,
      selEnd: lineStart + 1,
    };
  }

  // Build the continuation prefix
  let nextBullet = bullet;
  const numMatch = bullet.match(/^(\d+)\.$/);
  if (numMatch) {
    nextBullet = `${parseInt(numMatch[1], 10) + 1}.`;
  }
  const nextCheckbox = checkbox ? '[ ] ' : '';
  const continuation = `\n${indent}${nextBullet} ${nextCheckbox}`;

  return {
    text: text.slice(0, selStart) + continuation + text.slice(selStart),
    selStart: selStart + continuation.length,
    selEnd: selStart + continuation.length,
  };
}

// ── Tab indentation ────────────────────────────────────────────────────

export function handleTabIndent(
  text: string,
  selStart: number,
  selEnd: number,
  shiftKey: boolean,
): TextEditResult {
  const lines = getSelectedLines(text, selStart, selEnd);

  if (lines.length <= 1 && selStart === selEnd && !shiftKey) {
    // Single cursor, no selection — just insert 2 spaces
    return {
      text: text.slice(0, selStart) + '  ' + text.slice(selStart),
      selStart: selStart + 2,
      selEnd: selStart + 2,
    };
  }

  // Multi-line or dedent: indent/dedent all lines
  let newText = text;
  let startDelta = 0;
  let totalDelta = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const { lineStart, lineText } = lines[i];
    const adjustedStart = lineStart + totalDelta;

    if (shiftKey) {
      // Dedent: remove up to 2 leading spaces
      const spacesToRemove = lineText.startsWith('  ') ? 2 : lineText.startsWith(' ') ? 1 : 0;
      if (spacesToRemove > 0) {
        newText = newText.slice(0, lineStart) + newText.slice(lineStart + spacesToRemove);
        totalDelta -= spacesToRemove;
        if (i === 0) startDelta = -spacesToRemove;
      }
    } else {
      // Indent: add 2 spaces
      newText = newText.slice(0, lineStart) + '  ' + newText.slice(lineStart);
      totalDelta += 2;
      if (i === 0) startDelta = 2;
    }
  }

  return {
    text: newText,
    selStart: Math.max(0, selStart + startDelta),
    selEnd: selEnd + totalDelta,
  };
}

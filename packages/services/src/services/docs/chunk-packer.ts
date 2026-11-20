/**
 * Code- and table-aware packing for the section chunker.
 *
 * The naive splitter broke a section into ≤maxChars pieces at blank-line
 * boundaries — which can sever a long fenced code block mid-statement or
 * split a markdown table away from its header row, both actively harmful when
 * an agent grounds code against the result. This packer instead treats fenced
 * code blocks and tables as ATOMIC: they're never split (kept whole even when
 * they exceed maxChars), so the agent always sees valid, complete code/tables.
 * Ordinary prose paragraphs still pack greedily and hard-split only as a last
 * resort for a single pathological paragraph.
 */

/** A logical block. `atomic` blocks (code fences, tables) are never split. */
interface Block {
  text: string;
  atomic: boolean;
}

export function openingFence(line: string): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1]![0] === '`' && match[2]!.includes('`'))) return;
  return match[1];
}

export function closesFence(line: string, opening: string): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1]![0] === opening[0] && match[1]!.length >= opening.length;
}

/**
 * Split `body` into pieces of at most `maxChars`, never cutting inside a
 * fenced code block or a markdown table. Returns `[body]` unchanged when it
 * already fits.
 */
export function packSections(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];
  const blocks = splitIntoBlocks(body);
  const pieces: string[] = [];
  let buf = '';
  for (const b of blocks) {
    const candidate = buf ? `${buf}\n\n${b.text}` : b.text;
    if (candidate.length <= maxChars) {
      buf = candidate;
      continue;
    }
    if (buf) {
      pieces.push(buf);
      buf = '';
    }
    if (b.text.length <= maxChars) {
      buf = b.text;
    } else if (b.atomic) {
      // Oversized code/table — emit whole rather than break its syntax.
      pieces.push(b.text);
    } else {
      // Pathological single paragraph — hard-split into char windows.
      for (let k = 0; k < b.text.length; k += maxChars) {
        pieces.push(b.text.slice(k, k + maxChars));
      }
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function splitIntoBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];
  const flushPara = () => {
    const text = buf.join('\n').trim();
    if (text) blocks.push({ text, atomic: false });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = openingFence(line);
    if (fence) {
      flushPara();
      const code = [line];
      i++;
      for (; i < lines.length; i++) {
        code.push(lines[i]!);
        if (closesFence(lines[i]!, fence)) break;
      }
      blocks.push({ text: code.join('\n'), atomic: true });
      continue;
    }
    if (isTableStart(lines, i)) {
      flushPara();
      const table = [line];
      i++;
      for (; i < lines.length; i++) {
        if (lines[i]!.includes('|') && lines[i]!.trim() !== '') {
          table.push(lines[i]!);
        } else {
          i--;
          break;
        }
      }
      blocks.push({ text: table.join('\n'), atomic: true });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    buf.push(line);
  }
  flushPara();
  return blocks;
}

/**
 * A markdown table starts with a pipe row followed by a `|---|` separator.
 * The separator MUST contain a pipe — a bare `---` is a horizontal rule /
 * setext underline, not a table delimiter; requiring the pipe stops prose like
 * `a | b` followed by `---` from being misread as a table.
 */
function isTableStart(lines: string[], i: number): boolean {
  const cur = lines[i] ?? '';
  const next = lines[i + 1] ?? '';
  return (
    cur.includes('|') &&
    next.includes('|') &&
    next.includes('-') &&
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next)
  );
}

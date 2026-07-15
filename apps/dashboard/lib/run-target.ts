/**
 * Pure helpers for "run this" affordances (editor gutter + file-tree menu).
 * No React / no Monaco — just maps file extensions to a runtime and locates
 * runnable lines in manifest/source text. Shared so the editor gutter and the
 * tree context menu agree on what's runnable.
 */

import { type RunnerManager, snippetRunFor } from '@mcp/api-bus';

export type FileRuntime = 'node' | 'php' | 'python' | 'java' | 'dotnet';

/** Extension → runtime. `.ts` is intentionally absent (needs a loader). */
const EXT_RUNTIME: Record<string, FileRuntime> = {
  php: 'php',
  py: 'python',
  js: 'node',
  mjs: 'node',
  cjs: 'node',
  java: 'java',
  cs: 'dotnet',
};

export interface RunTarget {
  runtime: FileRuntime;
  /** Doubles as the runner `manager` tag (the union now includes the runtimes). */
  manager: RunnerManager;
}

function extOf(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  return base.includes('.') ? (base.split('.').pop() ?? '') : '';
}

/** A whole-file run target for a supported source file, or null. */
export function runnableForFile(path: string): RunTarget | null {
  const rt = EXT_RUNTIME[extOf(path)];
  return rt ? { runtime: rt, manager: rt } : null;
}

/** Build/project manifests that can resolve one project-level Run target. */
export function isProjectRunFile(path: string): boolean {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  return base === 'pom.xml' || base === 'build.gradle' || base === 'build.gradle.kts' || base.endsWith('.csproj');
}

/** First meaningful declaration line used for a project-level gutter glyph. */
export function findProjectRunLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  let inBlockComment = false;
  let inXmlComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (inXmlComment) {
      if (line.includes('-->')) inXmlComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->', 4)) inXmlComment = true;
      continue;
    }
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/', 2)) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('<?xml')) continue;
    return i + 1;
  }
  return null;
}

/**
 * Map each top-level key inside the `"scripts"` object to its 1-based line.
 * A tiny brace/string scanner (no JSON AST) — only records keys at depth 1 of
 * the scripts object (so nested objects/arrays in composer scripts are
 * ignored). Reflects the LIVE buffer, so unsaved script edits show glyphs.
 */
export function findScriptLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const m = /"scripts"\s*:\s*\{/.exec(text);
  if (!m) return out;

  let i = m.index + m[0].length; // just past the opening `{`
  let depth = 1;
  let lineNo = 1;
  for (let k = 0; k < i; k++) if (text[k] === '\n') lineNo++;

  const len = text.length;
  while (i < len && depth > 0) {
    const ch = text[i];
    if (ch === '\n') {
      lineNo++;
      i++;
      continue;
    }
    if (ch === '"') {
      const strLine = lineNo;
      let s = '';
      i++;
      while (i < len) {
        const c = text[i];
        if (c === '\\') {
          s += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        if (c === '\n') lineNo++;
        s += c;
        i++;
      }
      // Skip whitespace, then a string is a KEY iff a `:` follows at depth 1.
      while (i < len && /\s/.test(text[i])) {
        if (text[i] === '\n') lineNo++;
        i++;
      }
      if (depth === 1 && text[i] === ':') {
        // Peek the value's first non-ws char; object values ({...}, e.g. a
        // nested composer script group) aren't runnable, so don't glyph them.
        let j = i + 1;
        while (j < len && /\s/.test(text[j])) j++;
        if (text[j] !== '{') out.set(strLine, s);
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return out;
}

/**
 * Find runnable fenced code blocks in markdown text. Returns the 1-based line
 * of each opening fence (where the ▶ goes), its language, and the block body.
 * Mirrors the CommonMark fence rules: ``` or ~~~ (3+), closing fence is the
 * same char and at least as long. ONLY emits blocks that are CLOSED (an
 * unterminated fence — mid-edit — yields no glyph) and whose language is
 * runnable (`snippetRunFor` != null). Any other fenced block is skipped over
 * (so its contents aren't re-scanned) but not recorded.
 */
export function findCodeBlocks(text: string): Array<{ line: number; language: string; code: string }> {
  const out: Array<{ line: number; language: string; code: string }> = [];
  // Split on CRLF *or* LF: a trailing \r left by a plain `\n` split would break
  // the closing-fence match (its `$` sits after the \r), so a CRLF markdown
  // file — common on Windows — would detect zero blocks. Normalising to LF here
  // also gives the snippet temp file clean line endings.
  const lines = text.split(/\r?\n/);
  const openRe = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]+)?/;
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i]);
    if (!m) continue;
    const marker = m[1][0]; // ` or ~
    const fenceLen = m[1].length;
    const language = (m[2] ?? '').toLowerCase();
    const closeRe = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`);
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) { close = j; break; }
    }
    if (close === -1) break; // unterminated fence runs to EOF — no more blocks
    if (snippetRunFor(language)) {
      out.push({ line: i + 1, language, code: lines.slice(i + 1, close).join('\n') });
    }
    i = close; // resume scanning after this block's closing fence
  }
  return out;
}

/** 1-based line of `if __name__ == "__main__":`, or null. */
export function findPythonMainLine(text: string): number | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(lines[i])) return i + 1;
  }
  return null;
}

/** 1-based line of a Java `public static void main` declaration. */
export function findJavaMainLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/\bpublic\s+static\s+void\s+main\s*\(/.test(lines[i])) return i + 1;
  }
  return null;
}

/** C# Main declaration, or the first statement of a top-level-program file. */
export function findCsharpMainLine(text: string): number | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/\bstatic\s+(?:async\s+)?(?:void|int|Task|Task<int>)\s+Main\s*\(/.test(lines[i])) return i + 1;
  }
  if (/\b(?:class|struct|interface|namespace)\b/.test(text)) return null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('//') && !line.startsWith('/*') && !/^using\s/.test(line)) return i + 1;
  }
  return null;
}

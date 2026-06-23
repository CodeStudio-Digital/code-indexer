/**
 * Orchestrator for visual edits: stamp loc → file → locate → rewrite →
 * write → fresh loc. Pure I/O wrapper around the parse/rewrite modules so
 * the HTTP handler stays a thin validation layer.
 *
 * Concurrency contract: the dashboard gates edits on the agent being idle
 * and chains `newLoc`/`fileHash` between consecutive edits; a mismatched
 * `expectFileHash` means someone else wrote the file → 409-shaped refusal
 * (`stale: true`) so the UI asks the user to re-pick the element.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { locateAt, locByOrdinal, parseSource } from './locate.js';
import { rewriteClasses } from './rewrite-classes.js';
import { rewriteText } from './rewrite-text.js';

export type VisualEditOp =
  | { kind: 'set-classes'; classes: string }
  | { kind: 'set-text'; text: string };

export interface VisualEditRequest {
  projectRoot: string;
  /** Stamp loc — `relpath:line:col` (forward slashes, 1-based). */
  loc: string;
  op: VisualEditOp;
  /** DOM tag at click time — cheap stale check for lowercase HTML tags. */
  expectTag?: string;
  /** Optimistic-concurrency token from the previous edit's response. */
  expectFileHash?: string;
}

export type VisualEditResult =
  | { ok: true; newLoc: string; fileHash: string }
  | { ok: false; stale: boolean; reason: string };

/** Files the visual editor must never touch (preview tooling + config). */
const RESERVED_RE = [
  /^\.mcp\//,
  /^src\/mcp-inspector\.ts$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /(^|\/)node_modules\//,
];

function hashOf(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export function parseStampLoc(loc: string): { path: string; line: number; column: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(loc);
  if (!m) return null;
  const line = Number(m[2]);
  const column = Number(m[3]);
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null;
  return { path: m[1].replace(/\\/g, '/'), line, column };
}

export function applyVisualEdit(req: VisualEditRequest): VisualEditResult {
  const target = parseStampLoc(req.loc);
  if (!target) return { ok: false, stale: false, reason: `invalid loc "${req.loc}"` };

  const rel = target.path;
  if (isAbsolute(rel) || normalize(rel).split(sep).includes('..')) {
    return { ok: false, stale: false, reason: 'loc escapes the project root' };
  }
  if (RESERVED_RE.some((re) => re.test(rel))) {
    return { ok: false, stale: false, reason: `"${rel}" is preview tooling — not editable` };
  }

  const abs = join(req.projectRoot, rel);
  let code: string;
  try {
    code = readFileSync(abs, 'utf-8');
  } catch {
    return { ok: false, stale: true, reason: `file not found: ${rel}` };
  }

  if (req.expectFileHash && hashOf(code) !== req.expectFileHash) {
    return { ok: false, stale: true, reason: 'file changed since the last edit — re-pick the element' };
  }

  let ast;
  try {
    ast = parseSource(code);
  } catch (e) {
    return { ok: false, stale: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const located = locateAt(ast, target.line, target.column);
  if (!located) {
    return { ok: false, stale: true, reason: 'no JSX element at the stamped position — re-pick the element' };
  }
  // DOM tags are lowercase; component stamps (e.g. `Button`) render as
  // something else entirely, so only same-case HTML tags are comparable.
  if (
    req.expectTag &&
    located.tagName === located.tagName.toLowerCase() &&
    located.tagName !== req.expectTag.toLowerCase()
  ) {
    return { ok: false, stale: true, reason: `expected <${req.expectTag}> but found <${located.tagName}> — re-pick the element` };
  }

  const rewritten =
    req.op.kind === 'set-classes'
      ? rewriteClasses(code, located.opening, req.op.classes)
      : located.element
        ? rewriteText(code, located.element, req.op.text)
        : { ok: false as const, reason: 'self-closing element has no text' };

  if (!rewritten.ok) return { ok: false, stale: false, reason: rewritten.reason };

  try {
    writeFileSync(abs, rewritten.code, 'utf-8');
  } catch (e) {
    return { ok: false, stale: false, reason: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // Same ordinal in the new code → fresh stamp loc for chained edits.
  let newLoc = req.loc;
  try {
    const pos = locByOrdinal(parseSource(rewritten.code), located.ordinal);
    if (pos) newLoc = `${rel}:${pos}`;
  } catch {
    /* keep the old loc — next edit will 409 and ask for a re-pick */
  }

  return { ok: true, newLoc, fileHash: hashOf(rewritten.code) };
}

/**
 * `apply_patch` — Codex-style freeform patch tool.
 *
 * Format mirrors the official Codex CLI patch protocol
 * (codex-rs/apply-patch/src/parser.rs):
 *
 *   *** Begin Patch
 *   *** Add File: path/to/new.ts
 *   +line one
 *   +line two
 *   *** Update File: path/to/existing.ts
 *   @@ optional context (ignored when locating the hunk)
 *    unchanged context line
 *   -removed line
 *   +added line
 *   *** Delete File: path/to/dead.ts
 *   *** End Patch
 *
 * Sent to chatgpt/Codex models as a `type: 'custom'` (freeform) tool when
 * `provider_models.apply_patch_tool_type === 'freeform'`. For other models
 * it is registered as a regular function tool with a single `patch` string
 * parameter — the model emits the patch text verbatim and we apply it.
 *
 * The handler fully parses + applies inside the project sandbox via the
 * same filesystem port the other fs tools use, so tests can swap the FS.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { resolveWorkspacePath, pathFor } from '@mcp/code-agent/tools/paths.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '@mcp/code-agent/ports/filesystem-port.js';

function fsPort(ctx: ToolContext): IFilesystemPort {
  return ctx.ports?.fs ?? defaultLocalFilesystemPort();
}

// ─── Patch model ──────────────────────────────────────────────────

export interface PatchHunk {
  /** Unchanged context lines preceding the change. */
  contextBefore: string[];
  /** Lines removed from the file. */
  removed: string[];
  /** Lines added to the file. */
  added: string[];
  /** Unchanged context lines following the change. */
  contextAfter: string[];
}

export type PatchAction =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; hunks: PatchHunk[] };

export interface ParsedPatch {
  actions: PatchAction[];
}

// ─── Parser ───────────────────────────────────────────────────────

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';

export function parseApplyPatch(input: string): ParsedPatch {
  const trimmed = input.replace(/^\s*<<['"]?EOF['"]?\s*\n/, '').replace(/\nEOF\s*$/, '\n');
  const lines = trimmed.split(/\r?\n/);

  // Locate begin/end markers (lenient: accept leading/trailing whitespace).
  let i = 0;
  while (i < lines.length && lines[i].trim() !== BEGIN) i++;
  if (i >= lines.length) {
    throw new Error(`apply_patch: missing '${BEGIN}' header`);
  }
  i++; // past BEGIN

  const actions: PatchAction[] = [];

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === END) {
      i++;
      break;
    }
    if (line === '' || line.startsWith('#')) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const nxt = lines[i];
        const ntrim = nxt.trim();
        if (
          ntrim === END ||
          ntrim.startsWith('*** Add File: ') ||
          ntrim.startsWith('*** Update File: ') ||
          ntrim.startsWith('*** Delete File: ')
        ) {
          break;
        }
        if (nxt.startsWith('+')) {
          collected.push(nxt.slice(1));
        } else if (nxt === '') {
          collected.push('');
        } else {
          throw new Error(`apply_patch: unexpected line in Add File block (line ${i + 1}): ${nxt}`);
        }
        i++;
      }
      actions.push({ kind: 'add', path, lines: collected });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      actions.push({ kind: 'delete', path });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let movePath: string | undefined;
      if (i < lines.length && lines[i].trim().startsWith('*** Move to: ')) {
        movePath = lines[i].trim().slice('*** Move to: '.length).trim();
        i++;
      }
      const hunks: PatchHunk[] = [];
      let cur: PatchHunk | null = null;
      // Phase machine for multi-block hunks. A single `@@` block can contain
      // multiple non-adjacent change groups separated by unchanged context
      // (standard unified-diff format). We auto-split into separate PatchHunks
      // so the applier's exact-substring search finds each contiguous segment.
      //   before → leading context (no +/- seen yet)
      //   change → inside a +/- group
      //   after  → trailing context (after at least one +/-, before any next +/-)
      // A +/- in phase `after` triggers a split: flush current hunk, start a
      // new one whose contextBefore is the collected contextAfter (the anchor
      // carries forward, matching how `git apply` handles such hunks).
      type Phase = 'before' | 'change' | 'after';
      let phase: Phase = 'before';
      const flushHunk = () => {
        if (cur && (cur.removed.length || cur.added.length || cur.contextBefore.length || cur.contextAfter.length)) {
          hunks.push(cur);
        }
        cur = null;
        phase = 'before';
      };
      while (i < lines.length) {
        const nxt = lines[i];
        const ntrim = nxt.trim();
        if (
          ntrim === END ||
          ntrim.startsWith('*** Add File: ') ||
          ntrim.startsWith('*** Update File: ') ||
          ntrim.startsWith('*** Delete File: ')
        ) {
          break;
        }
        if (ntrim.startsWith('@@')) {
          flushHunk();
          cur = { contextBefore: [], removed: [], added: [], contextAfter: [] };
          phase = 'before';
          i++;
          continue;
        }
        if (cur === null) {
          cur = { contextBefore: [], removed: [], added: [], contextAfter: [] };
          phase = 'before';
        }
        // `cur` is non-null here, but TS loses narrowing because `flushHunk`
        // (a closure declared above) can reassign it. Hoist into a local.
        const c: PatchHunk = cur;
        // Diff lines
        if (nxt.startsWith('+') || nxt.startsWith('-')) {
          if (phase === 'after') {
            // Multi-block hunk: previous change group ended at contextAfter.
            // Flush it and start a new hunk that re-uses contextAfter as its
            // contextBefore — anchors the next search against the same lines
            // that ended the previous one.
            const carry = c.contextAfter;
            hunks.push(c);
            cur = { contextBefore: [...carry], removed: [], added: [], contextAfter: [] };
            if (nxt.startsWith('+')) {
              cur.added.push(nxt.slice(1));
            } else {
              cur.removed.push(nxt.slice(1));
            }
          } else {
            if (nxt.startsWith('+')) {
              c.added.push(nxt.slice(1));
            } else {
              c.removed.push(nxt.slice(1));
            }
          }
          phase = 'change';
        } else if (nxt.startsWith(' ') || nxt === '') {
          const text = nxt.startsWith(' ') ? nxt.slice(1) : '';
          if (phase === 'before') {
            c.contextBefore.push(text);
          } else {
            c.contextAfter.push(text);
            phase = 'after';
          }
        } else {
          throw new Error(`apply_patch: unexpected line in Update File block (line ${i + 1}): ${nxt}`);
        }
        i++;
      }
      flushHunk();
      actions.push({ kind: 'update', path, movePath, hunks });
      continue;
    }
    throw new Error(`apply_patch: unexpected directive at line ${i + 1}: ${line}`);
  }

  return { actions };
}

// ─── Normalization helpers ────────────────────────────────────────
//
// The Codex patch format is LF-only by construction (the parser splits on
// /\r?\n/). But files on Windows usually have CRLF, and some have a UTF-8
// BOM. If we `indexOf` an LF-built search string in CRLF content the match
// fails on every multi-line hunk — that's the "apply_patch never works"
// bug. We normalize on read, then restore the original convention on
// write so unrelated lines aren't churned in the diff.

const BOM = '﻿';

interface NormalizedContent {
  text: string;
  eol: '\r\n' | '\n';
  bom: boolean;
}

function detectEOL(s: string): '\r\n' | '\n' {
  // Sample the first 4 KB — enough to classify any real-world source file
  // without scanning megabytes when only the leading hunk matters.
  const head = s.length > 4096 ? s.slice(0, 4096) : s;
  return head.includes('\r\n') ? '\r\n' : '\n';
}

function normalize(raw: string): NormalizedContent {
  let text = raw;
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = detectEOL(text);
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n');
  return { text, eol, bom };
}

function denormalize(text: string, eol: '\r\n' | '\n', bom: boolean): string {
  let out = eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  if (bom) out = BOM + out;
  return out;
}

function formatHunkError(
  path: string,
  hunk: PatchHunk,
  search: string,
  norm: NormalizedContent,
  fileLineCount: number,
): string {
  // Render \n as ⏎ so the diagnostic survives the JSON encoding chain to
  // the model — escaped \n in error messages reads as a literal `\n`,
  // which is confusing. Truncate to 80 chars; the failure cause almost
  // always sits in the first line or two of context.
  const previewRaw = search.slice(0, 80).replace(/\n/g, '⏎');
  const suffix = search.length > 80 ? '…' : '';
  // Make explicit that CRLF/BOM are handled before matching — the file's
  // line endings and BOM status are descriptive, not the failure cause.
  // Users frequently mis-read "no BOM" as a diagnostic claim.
  const bomFlag = norm.bom ? 'BOM stripped for matching' : 'no BOM detected';
  const eolLabel = norm.eol === '\r\n' ? 'CRLF normalized for matching' : 'LF';
  return (
    `apply_patch: hunk for '${path}' did not match source.\n` +
    `  Searched for ${search.length} chars (before=${hunk.contextBefore.length} ` +
    `removed=${hunk.removed.length} after=${hunk.contextAfter.length}).\n` +
    `  File: ${fileLineCount} lines (${eolLabel}, ${bomFlag}).\n` +
    `  Search starts with: "${previewRaw}${suffix}"`
  );
}

// ─── Applier ──────────────────────────────────────────────────────

export interface ApplyResult {
  added: string[];
  updated: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
}

type PlannedOp =
  | { kind: 'add'; abs: string; data: string; relPath: string; displayPath: string; rootPath: string; external: boolean; projectId?: number }
  | { kind: 'delete'; abs: string; relPath: string; displayPath: string; rootPath: string; external: boolean; projectId?: number }
  | { kind: 'write'; abs: string; data: string; relPath: string; displayPath: string; rootPath: string; external: boolean; projectId?: number }
  | {
      kind: 'move';
      oldAbs: string;
      newAbs: string;
      data: string;
      oldRel: string;
      newRel: string;
      oldDisplay: string;
      newDisplay: string;
      rootPath: string;
      external: boolean;
      projectId?: number;
    };

function markOverlay(
  ctx: ToolContext,
  projectId: number | undefined,
  relativePath: string,
  external: boolean,
): void {
  if (external) return;
  const overlay = projectId != null
    ? ctx.overlayByRoot?.get(projectId) ?? ctx.overlay
    : ctx.overlay;
  overlay?.mark(relativePath);
}

export async function applyParsedPatch(
  patch: ParsedPatch,
  ctx: ToolContext,
): Promise<ApplyResult> {
  const fs = fsPort(ctx);
  const planned: PlannedOp[] = [];
  // Maps the *post-action* path (movePath when present, else path) to the
  // already-computed final content. Covers the rare case of a patch that
  // updates the same file twice, or updates then moves it: phase 1 must
  // chain through in-memory results because nothing has been written yet.
  const inMemoryUpdates = new Map<string, string>();

  // ─── Phase 1: plan ────────────────────────────────────────────
  // Validate every hunk, compute every final file content. No disk
  // writes. Any `throw` here leaves the working tree untouched.
  for (const action of patch.actions) {
    if (action.kind === 'add') {
      const resolved = resolveWorkspacePath(action.path, ctx, 'write');
      if (!resolved.ok) throw new Error(`apply_patch: ${resolved.reason}`);
      planned.push({
        kind: 'add',
        abs: resolved.abs,
        data: action.lines.join('\n'),
        relPath: resolved.relativePath,
        displayPath: action.path,
        rootPath: resolved.rootPath,
        external: resolved.external,
        projectId: resolved.projectId,
      });
      continue;
    }

    if (action.kind === 'delete') {
      const resolved = resolveWorkspacePath(action.path, ctx, 'write');
      if (!resolved.ok) throw new Error(`apply_patch: ${resolved.reason}`);
      planned.push({
        kind: 'delete',
        abs: resolved.abs,
        relPath: resolved.relativePath,
        displayPath: action.path,
        rootPath: resolved.rootPath,
        external: resolved.external,
        projectId: resolved.projectId,
      });
      continue;
    }

    // update
    const resolved = resolveWorkspacePath(action.path, ctx, 'write');
    if (!resolved.ok) throw new Error(`apply_patch: ${resolved.reason}`);
    const abs = resolved.abs;
    let newAbs: string | null = null;
    let moveResolved: Extract<ReturnType<typeof resolveWorkspacePath>, { ok: true }> | null = null;
    if (action.movePath) {
      const target = resolveWorkspacePath(action.movePath, ctx, 'write');
      if (!target.ok) throw new Error(`apply_patch: ${target.reason}`);
      if (target.rootPath.toLowerCase() !== resolved.rootPath.toLowerCase()) {
        throw new Error('apply_patch: moves across project/external root boundaries are not allowed');
      }
      moveResolved = target;
      newAbs = target.abs;
    }

    const buffered = inMemoryUpdates.get(abs);
    const raw = buffered ?? (await fs.readFile(abs)).toString();
    const norm = normalize(raw);
    let text = norm.text;
    const fileLineCount = text.split('\n').length;

    for (const hunk of action.hunks) {
      const before = hunk.contextBefore.join('\n');
      const removed = hunk.removed.join('\n');
      const after = hunk.contextAfter.join('\n');
      const added = hunk.added.join('\n');

      const search = [before, removed, after].filter((s) => s.length > 0).join('\n');
      const replace = [before, added, after].filter((s) => s.length > 0).join('\n');

      const idx = text.indexOf(search);
      if (idx === -1) {
        throw new Error(formatHunkError(action.path, hunk, search, norm, fileLineCount));
      }
      text = text.slice(0, idx) + replace + text.slice(idx + search.length);
    }

    const finalContent = denormalize(text, norm.eol, norm.bom);
    // Key on the post-action absolute path so subsequent updates target
    // the correct buffer even after a Move.
    inMemoryUpdates.set(newAbs ?? abs, finalContent);

    if (newAbs) {
      planned.push({
        kind: 'move',
        oldAbs: abs,
        newAbs,
        data: finalContent,
        oldRel: resolved.relativePath,
        newRel: moveResolved!.relativePath,
        oldDisplay: action.path,
        newDisplay: action.movePath!,
        rootPath: moveResolved!.rootPath,
        external: moveResolved!.external,
        projectId: moveResolved!.projectId,
      });
    } else {
      planned.push({
        kind: 'write',
        abs,
        data: finalContent,
        relPath: resolved.relativePath,
        displayPath: action.path,
        rootPath: resolved.rootPath,
        external: resolved.external,
        projectId: resolved.projectId,
      });
    }
  }

  // ─── Phase 2: commit ───────────────────────────────────────────
  // Sequential FS writes. Phase 1 already proved every hunk matches; the
  // only failures here are environmental (permissions, disk full, concurrent
  // mutation). Best-effort — on failure we surface what got committed so a
  // human can decide whether to retry. Not crash-safe (no temp+rename);
  // tracked as a follow-up.
  const result: ApplyResult = { added: [], updated: [], deleted: [], moved: [] };
  for (let i = 0; i < planned.length; i++) {
    const op = planned[i];
    const path = pathFor(op.rootPath);
    try {
      if (op.kind === 'add') {
        await fs.mkdir(path.dirname(op.abs), { recursive: true });
        await fs.writeFile(op.abs, op.data);
        markOverlay(ctx, op.projectId, op.relPath, op.external);
        result.added.push(op.displayPath);
      } else if (op.kind === 'delete') {
        await fs.unlink(op.abs);
        markOverlay(ctx, op.projectId, op.relPath, op.external);
        result.deleted.push(op.displayPath);
      } else if (op.kind === 'write') {
        await fs.writeFile(op.abs, op.data);
        markOverlay(ctx, op.projectId, op.relPath, op.external);
        result.updated.push(op.displayPath);
      } else {
        // move: write new first, then unlink old. If write fails the
        // original file still exists — never both gone.
        await fs.mkdir(path.dirname(op.newAbs), { recursive: true });
        await fs.writeFile(op.newAbs, op.data);
        await fs.unlink(op.oldAbs);
        markOverlay(ctx, op.projectId, op.oldRel, op.external);
        markOverlay(ctx, op.projectId, op.newRel, op.external);
        result.moved.push({ from: op.oldDisplay, to: op.newDisplay });
        result.updated.push(op.newDisplay);
      }
    } catch (e) {
      const failedLabel = describeOp(op);
      const committedLabel = planned
        .slice(0, i)
        .map(describeOp)
        .join(', ');
      throw new Error(
        `apply_patch: partial commit at op ${i + 1}/${planned.length} (${failedLabel}). ` +
          `committed=[${committedLabel}]. cause: ${(e as Error).message}`,
      );
    }
  }

  return result;
}

function describeOp(op: PlannedOp): string {
  if (op.kind === 'move') return `move:${op.oldDisplay}->${op.newDisplay}`;
  return `${op.kind}:${op.displayPath}`;
}

// ─── Tool definition ──────────────────────────────────────────────

const APPLY_PATCH_DESC = `Apply a Codex-style patch describing file additions, deletions, and updates.

The patch is a single block delimited by \`*** Begin Patch\` and \`*** End Patch\`. Inside, list one or more file actions:

  *** Add File: path/to/new.ts
  +first line
  +second line
  *** Update File: path/to/existing.ts
  @@ optional context (ignored)
   unchanged context line
  -removed line
  +added line
  *** Delete File: path/to/dead.ts

Update hunks must include enough surrounding context (\` \`-prefixed lines) to make the search unambiguous — the implementation locates each hunk by exact-substring match. Use multiple hunks per file when needed; separate them with a blank line or a fresh \`@@\` line.

Prefer this tool over per-file edit tools when changing several files at once; the model that supports it (\`apply_patch_tool_type: 'freeform'\`) emits the patch text directly without JSON escaping.`;

export const applyPatchTool: CoderTool = {
  name: 'apply_patch',
  effectBoundary: 'filesystem',
  description: APPLY_PATCH_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          "Full patch text starting with '*** Begin Patch' and ending with '*** End Patch'.",
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    // Custom tools deliver the raw input under `_raw` (see chatgpt provider's
    // custom_tool_call handling); function-tools deliver structured `patch`.
    const raw =
      typeof args.patch === 'string'
        ? args.patch
        : typeof (args as { _raw?: unknown })._raw === 'string'
          ? ((args as { _raw: string })._raw)
          : '';
    if (!raw.trim()) return err('apply_patch: missing patch text');

    let parsed: ParsedPatch;
    try {
      parsed = parseApplyPatch(raw);
    } catch (e) {
      return err((e as Error).message);
    }

    let result: ApplyResult;
    try {
      result = await applyParsedPatch(parsed, ctx);
    } catch (e) {
      return err((e as Error).message);
    }

    const lines: string[] = [];
    if (result.added.length) lines.push(`Added: ${result.added.join(', ')}`);
    if (result.updated.length) lines.push(`Updated: ${result.updated.join(', ')}`);
    if (result.deleted.length) lines.push(`Deleted: ${result.deleted.join(', ')}`);
    if (result.moved.length)
      lines.push(`Moved: ${result.moved.map((m) => `${m.from} -> ${m.to}`).join(', ')}`);
    if (lines.length === 0) lines.push('No changes applied.');
    return ok(lines.join('\n'));
  },
};

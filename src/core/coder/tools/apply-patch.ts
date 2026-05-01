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
import { unlink } from 'node:fs/promises';
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { resolveSafe as resolveSafePath, pathFor } from './paths.js';
import {
  defaultLocalFilesystemPort,
  type IFilesystemPort,
} from '../ports/filesystem-port.js';

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
      const flushHunk = () => {
        if (cur && (cur.removed.length || cur.added.length || cur.contextBefore.length || cur.contextAfter.length)) {
          hunks.push(cur);
        }
        cur = null;
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
          i++;
          continue;
        }
        if (cur === null) {
          cur = { contextBefore: [], removed: [], added: [], contextAfter: [] };
        }
        // Diff lines
        if (nxt.startsWith('+')) {
          cur.added.push(nxt.slice(1));
        } else if (nxt.startsWith('-')) {
          cur.removed.push(nxt.slice(1));
        } else if (nxt.startsWith(' ') || nxt === '') {
          // Context line. If we're still collecting the leading context
          // (no removed/added yet), append to contextBefore. Otherwise
          // it's trailing context.
          const text = nxt.startsWith(' ') ? nxt.slice(1) : '';
          if (cur.removed.length === 0 && cur.added.length === 0) {
            cur.contextBefore.push(text);
          } else {
            cur.contextAfter.push(text);
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

// ─── Applier ──────────────────────────────────────────────────────

export interface ApplyResult {
  added: string[];
  updated: string[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
}

export async function applyParsedPatch(
  patch: ParsedPatch,
  ctx: ToolContext,
): Promise<ApplyResult> {
  const fs = fsPort(ctx);
  const result: ApplyResult = { added: [], updated: [], deleted: [], moved: [] };

  for (const action of patch.actions) {
    if (action.kind === 'add') {
      const abs = resolveSafePath(action.path, ctx.cwd);
      if (!abs) throw new Error(`apply_patch: path '${action.path}' outside project root`);
      const content = action.lines.join('\n');
      await fs.mkdir(pathFor(ctx.cwd).dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
      ctx.overlay?.mark(action.path);
      result.added.push(action.path);
      continue;
    }
    if (action.kind === 'delete') {
      const abs = resolveSafePath(action.path, ctx.cwd);
      if (!abs) throw new Error(`apply_patch: path '${action.path}' outside project root`);
      await unlink(abs);
      ctx.overlay?.mark(action.path);
      result.deleted.push(action.path);
      continue;
    }
    // update
    const abs = resolveSafePath(action.path, ctx.cwd);
    if (!abs) throw new Error(`apply_patch: path '${action.path}' outside project root`);
    let content = (await fs.readFile(abs)).toString();

    for (const hunk of action.hunks) {
      const before = hunk.contextBefore.join('\n');
      const removed = hunk.removed.join('\n');
      const after = hunk.contextAfter.join('\n');
      const added = hunk.added.join('\n');

      const search = [before, removed, after].filter((s) => s.length > 0).join('\n');
      const replace = [before, added, after].filter((s) => s.length > 0).join('\n');

      const idx = content.indexOf(search);
      if (idx === -1) {
        throw new Error(
          `apply_patch: hunk for '${action.path}' did not match source. ` +
            `Searched for ${search.length} chars (before=${hunk.contextBefore.length} ` +
            `removed=${hunk.removed.length} after=${hunk.contextAfter.length}).`,
        );
      }
      content = content.slice(0, idx) + replace + content.slice(idx + search.length);
    }

    if (action.movePath) {
      const newAbs = resolveSafePath(action.movePath, ctx.cwd);
      if (!newAbs) throw new Error(`apply_patch: move target '${action.movePath}' outside project root`);
      await unlink(abs);
      await fs.mkdir(pathFor(ctx.cwd).dirname(newAbs), { recursive: true });
      await fs.writeFile(newAbs, content);
      ctx.overlay?.mark(action.path);
      ctx.overlay?.mark(action.movePath);
      result.moved.push({ from: action.path, to: action.movePath });
      result.updated.push(action.movePath);
    } else {
      await fs.writeFile(abs, content);
      ctx.overlay?.mark(action.path);
      result.updated.push(action.path);
    }
  }

  return result;
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

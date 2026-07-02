/**
 * Identifies file-editing tool calls and extracts the file(s) they touch, so the
 * chat can render a file-first block (path + diff) instead of raw tool JSON.
 *
 * Single-file tools carry `input.path`; `apply_patch` carries a Codex-style
 * patch string (`*** Add|Update|Delete File: <path>`, optional `*** Move to:`).
 */

export type FileEditOp = 'add' | 'edit' | 'delete' | 'rename';

export interface EditFileRef {
  path: string;
  op: FileEditOp;
}

export const EDIT_TOOLS = new Set<string>([
  'edit_file',
  'multi_edit',
  'write_file',
  'create_file',
  'apply_patch',
]);

export function isEditTool(name: string | undefined | null): boolean {
  return !!name && EDIT_TOOLS.has(name);
}

/** Pulls the raw patch text out of an `apply_patch` tool input (function-tool
 *  `patch` param, freeform `input`, or any string field carrying the header). */
function patchText(input: Record<string, unknown>): string {
  if (typeof input.patch === 'string') return input.patch;
  if (typeof input.input === 'string') return input.input;
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.includes('*** Begin Patch')) return v;
  }
  return '';
}

function filesFromPatch(input: Record<string, unknown>): EditFileRef[] {
  const text = patchText(input);
  if (!text) return [];
  const byPath = new Map<string, EditFileRef>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      byPath.set(m[1].trim(), { path: m[1].trim(), op: 'add' });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      byPath.set(m[1].trim(), { path: m[1].trim(), op: 'delete' });
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const orig = m[1].trim();
      const mv = /^\*\*\* Move to: (.+)$/.exec((lines[i + 1] ?? '').trim());
      const path = mv ? mv[1].trim() : orig;
      byPath.set(path, { path, op: mv ? 'rename' : 'edit' });
    }
  }
  return [...byPath.values()];
}

/** File(s) mutated by an edit tool call. `op` is a fallback badge hint — the
 *  authoritative A/M/D status comes from the session snapshot when available. */
export function filesFromEditToolCall(
  name: string | undefined | null,
  input: Record<string, unknown> | undefined | null,
): EditFileRef[] {
  // Guard: callers pass EVERY tool block (turn summaries, live refs), so a
  // non-edit tool that happens to carry a `path` (e.g. read_file) must yield [].
  if (!isEditTool(name) || !input) return [];
  if (name === 'apply_patch') return filesFromPatch(input);
  const p = typeof input.path === 'string' ? input.path : '';
  if (!p) return [];
  const op: FileEditOp = name === 'create_file' ? 'add' : 'edit';
  return [{ path: p, op }];
}

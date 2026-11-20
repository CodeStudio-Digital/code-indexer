/**
 * Overlay handlers — what the index tools still need for files touched in
 * the current session (created/edited/written).
 *
 * read_file, get_symbol_body and grep_code read current disk bytes in the
 * index tool core, so they need nothing here. Two gaps remain because the
 * structural index only refreshes symbols of already-indexed files:
 *   - get_file_skeleton answers from indexed symbols; a dirty file asks the
 *     core for its disk outline instead (internal `__prefer_disk`).
 *   - list_directory lists indexed files; a dirty file that is not indexed
 *     yet is added once, in the listing's own `path` form.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok } from '@mcp/code-agent/core/tool.js';
import type { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';

const OVERLAY_TAG = '[session overlay]';

export interface OverlayHandler {
  /** Internal arguments to add before dispatch (never visible to the model). */
  internalArgs?: (args: Record<string, unknown>, overlay: SessionOverlay) => Record<string, unknown> | null;
  /** Called AFTER a successful call. Returns the final ToolResult (possibly augmented). */
  postProcess?: (text: string, args: Record<string, unknown>, overlay: SessionOverlay, projectRoot: string) => ToolResult;
}

function getStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

// ─── get_file_skeleton ───────────────────────────────────────────

const handleGetFileSkeleton: OverlayHandler = {
  internalArgs: (args, overlay) => {
    const filePath = getStr(args, 'file_path');
    return filePath && overlay.isDirty(filePath) ? { __prefer_disk: true } : null;
  },
};

// ─── list_directory (merge) ──────────────────────────────────────

/** `src/a.ts (12L)`, `src/a.ts (340B)` or `src/dir/` → the listed path. */
function listedPath(line: string): string {
  return line.replace(/ \(\d+[LB]\)$/, '').replace(/\/$/, '');
}

const handleListDirectory: OverlayHandler = {
  postProcess: (text, args, overlay, projectRoot) => {
    // Extras belong to the first page only, so paging never repeats them.
    if (typeof args.offset === 'number' && args.offset > 0) return ok(text);
    const prefix = normalizePrefix(getStr(args, 'path') ?? '');
    const depth = typeof args.depth === 'number' ? args.depth : 2;
    const maxSlashes = depth + (prefix ? prefix.split('/').length : 0);
    const listed = new Set(text.split('\n').map(listedPath));
    const extras = overlay.filterDirty(prefix).filter((p) => {
      if (listed.has(p) || p.split('/').length - 1 > maxSlashes) return false;
      try { return statSync(join(projectRoot, p)).isFile(); } catch { return false; }
    }).sort();
    if (extras.length === 0) return ok(text);
    const body = text === 'Empty.' ? '' : text;
    return ok([body, `-- session overlay (${extras.length}) --`, ...extras.map((p) => `${p} ${OVERLAY_TAG}`)]
      .filter(Boolean).join('\n'));
  },
};

function normalizePrefix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
}

// ─── Lookup table ────────────────────────────────────────────────

const HANDLERS: Record<string, OverlayHandler> = {
  get_file_skeleton: handleGetFileSkeleton,
  list_directory: handleListDirectory,
};

export function getOverlayHandler(toolName: string): OverlayHandler | undefined {
  return HANDLERS[toolName];
}

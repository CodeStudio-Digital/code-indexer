/**
 * Overlay handlers — serve local disk reads for MCP tool calls when the
 * target file has been touched in the current session.
 *
 * Each handler returns a ToolResult (pre-intercept) to short-circuit the
 * MCP call entirely, or null to signal "delegate to MCP". Some tools
 * (list_directory, grep_code) also expose a `postProcess` that merges
 * dirty-file data into the MCP result.
 *
 * All parsing reuses helpers from src/services/code-reader.ts — no
 * duplication of regex or brace-balancing logic.
 */
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import type { SessionOverlay } from './session-overlay.js';
import {
  readFileSlice,
  extractSkeletonFromFile,
  findSymbolDeclLine,
  extractSymbolBody,
  grepInFiles,
} from '../../services/code-reader.js';

const OVERLAY_TAG = '[session overlay]';

export interface OverlayHandler {
  /** Called BEFORE delegating to MCP. Return non-null to short-circuit. */
  pre?: (args: Record<string, unknown>, overlay: SessionOverlay, projectRoot: string) => ToolResult | null;
  /** Called AFTER a successful MCP call. Returns the final ToolResult (possibly augmented). */
  postProcess?: (mcpText: string, args: Record<string, unknown>, overlay: SessionOverlay, projectRoot: string) => ToolResult;
}

function getStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

// ─── read_file ────────────────────────────────────────────────────

const handleReadFile: OverlayHandler = {
  pre: (args, overlay, projectRoot) => {
    const filePath = getStr(args, 'file_path');
    if (!filePath || !overlay.isDirty(filePath)) return null;

    const start = typeof args.start_line === 'number' ? args.start_line : 1;
    const maxLines = typeof args.max_lines === 'number' ? args.max_lines : 400;
    const end = typeof args.end_line === 'number' ? args.end_line : start + maxLines - 1;

    try {
      const { lines, total } = readFileSlice(join(projectRoot, filePath), start, end);
      const actualEnd = Math.min(total, end);
      const header = `${filePath} ${OVERLAY_TAG} (lines ${start}-${actualEnd} of ${total})`;
      const body = lines.map((l, i) => `${(start + i).toString().padStart(5)}\t${l}`).join('\n');
      const footer = actualEnd < total ? `\n... [${total - actualEnd} more lines — pass start_line/end_line to read more]` : '';
      return ok(`${header}\n${body}${footer}`);
    } catch (e) {
      return err(`overlay read_file failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ─── get_file_skeleton / get_file_structure ──────────────────────

function skeletonResult(filePath: string, projectRoot: string): ToolResult {
  const abs = join(projectRoot, filePath);
  let totalLines = 0;
  try {
    const { total } = readFileSlice(abs, 1, 1);
    totalLines = total;
  } catch {
    return err(`overlay: file ${filePath} not found on disk`);
  }
  const entries = extractSkeletonFromFile(abs);
  const header = `${filePath} | ? | ? | ${totalLines}L | ? ${OVERLAY_TAG}`;
  if (entries.length === 0) {
    return ok(`${header}\n(no symbols extracted — regex scan found nothing)`);
  }
  const lines = entries.map((e) => `${e.line.toString().padStart(5)}\t${e.kind}\t${e.name}\t${e.signature}`);
  return ok([header, ...lines].join('\n'));
}

const handleGetFileSkeleton: OverlayHandler = {
  pre: (args, overlay, projectRoot) => {
    const filePath = getStr(args, 'file_path');
    if (!filePath || !overlay.isDirty(filePath)) return null;
    return skeletonResult(filePath, projectRoot);
  },
};

const handleGetFileStructure: OverlayHandler = {
  pre: (args, overlay, projectRoot) => {
    const filePath = getStr(args, 'file_path');
    if (!filePath || !overlay.isDirty(filePath)) return null;
    return skeletonResult(filePath, projectRoot);
  },
};

// ─── get_symbol_body ─────────────────────────────────────────────

const handleGetSymbolBody: OverlayHandler = {
  pre: (args, overlay, projectRoot) => {
    const filePath = getStr(args, 'file_path');
    const symbolName = getStr(args, 'symbol_name');
    if (!filePath || !symbolName) return null;
    if (!overlay.isDirty(filePath)) return null;

    const abs = join(projectRoot, filePath);
    const line = findSymbolDeclLine(abs, symbolName);
    if (line === null) {
      return err(`overlay: symbol '${symbolName}' not found in ${filePath}`);
    }
    try {
      const body = extractSymbolBody(projectRoot, filePath, line);
      return ok(`${body.file}:${body.start_line}-${body.end_line} ${OVERLAY_TAG}\n${body.body}`);
    } catch (e) {
      return err(`overlay get_symbol_body failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ─── list_directory (merge) ──────────────────────────────────────

const handleListDirectory: OverlayHandler = {
  postProcess: (mcpText, args, overlay, _projectRoot) => {
    const prefix = getStr(args, 'path') ?? '';
    const overlayFiles = overlay.filterDirty(prefix);
    if (overlayFiles.length === 0) return ok(mcpText);

    // Only add files not already listed by the MCP server
    const extras = overlayFiles.filter((p) => {
      const base = p.split('/').pop() ?? p;
      return !mcpText.includes(base);
    });
    if (extras.length === 0) return ok(mcpText);

    const extraLines = extras.map((p) => {
      const parts = p.split('/');
      const baseDepth = prefix ? prefix.split('/').filter(Boolean).length : 0;
      const indent = '  '.repeat(Math.max(0, parts.length - baseDepth - 1));
      return `${indent}${parts[parts.length - 1]} ${OVERLAY_TAG}`;
    });

    const body = mcpText === 'Empty.' ? '' : mcpText;
    return ok([body, `-- session overlay (${extras.length}) --`, ...extraLines].filter(Boolean).join('\n'));
  },
};

// ─── grep_code (merge) ───────────────────────────────────────────

const handleGrepCode: OverlayHandler = {
  postProcess: (mcpText, args, overlay, projectRoot) => {
    const overlayFiles = overlay.filterDirty();
    if (overlayFiles.length === 0) return ok(mcpText);

    const pattern = getStr(args, 'pattern');
    if (!pattern) return ok(mcpText);

    const literal = args.literal === true;
    const ci = args.case_sensitive !== true;
    const maxResults = typeof args.max_results === 'number' ? args.max_results : 50;

    const escaped = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    let re: RegExp;
    try {
      re = new RegExp(escaped, ci ? 'i' : '');
    } catch {
      return ok(mcpText);
    }

    // Filter dirty files that actually exist on disk
    const existingDirty = overlayFiles.filter((p) => {
      try { statSync(join(projectRoot, p)); return true; } catch { return false; }
    });
    if (existingDirty.length === 0) return ok(mcpText);

    const hits = grepInFiles(projectRoot, existingDirty, re, maxResults);
    if (hits.length === 0) return ok(mcpText);

    const overlayLines = hits.map((h) => `${h.file}:${h.line}: ${h.text} ${OVERLAY_TAG}`);
    const body = mcpText === 'No matches.' ? '' : mcpText;
    return ok([body, ...overlayLines].filter(Boolean).join('\n'));
  },
};

// ─── Lookup table ────────────────────────────────────────────────

const HANDLERS: Record<string, OverlayHandler> = {
  read_file: handleReadFile,
  get_file_skeleton: handleGetFileSkeleton,
  get_file_structure: handleGetFileStructure,
  get_symbol_body: handleGetSymbolBody,
  list_directory: handleListDirectory,
  grep_code: handleGrepCode,
};

export function getOverlayHandler(toolName: string): OverlayHandler | undefined {
  return HANDLERS[toolName];
}

// Silence unused warning for `dirname` — kept in imports for possible future use
void dirname;

/**
 * Coalescing buffer between external LSP servers' publishDiagnostics and the
 * diagnostics hub.
 *
 * OmniSharp-class servers emit one notification PER FILE — thousands
 * back-to-back after a solution load — and the old direct path paid a
 * synchronous db.getProject per notification plus one hub frame per file,
 * all on the Electron main loop. The batcher accumulates latest-wins per
 * file and flushes on a short timer: ONE root resolution and ONE hub batch
 * per flush window.
 *
 * MODULE-SINGLETON-friendly: constructed once next to the manager wiring.
 */
import type { DiagnosticsFrame } from '@mcp/api-bus';
import { absToRelCanonical as absToRel } from '@mcp/shared/utils/fs-canonical.js';
import { fromLsp, mapSeverity, type LspDiagnostic, type LspRange0 } from '@mcp/services/lsp/lsp-protocol.js';
import { publishDiagnosticsBatch } from './diagnostics-hub.js';

const FLUSH_MS = (() => {
  const v = Number(process.env.MCP_LSP_DIAG_FLUSH_MS);
  return Number.isFinite(v) && v >= 0 ? v : 250;
})();
/** Pending-files ceiling per project — flush early instead of buffering unbounded. */
const MAX_PENDING_FILES = 500;

interface PendingFile {
  serverId: string;
  diagnostics: LspDiagnostic[];
}

export interface ServerDiagnosticsBatcherDeps {
  resolveRoot(projectId: number): string | null;
  /** Optional flush-time guard after absolute→relative canonicalization. */
  includeFile?(projectId: number, file: string, serverId: string): boolean;
  /** Injectable for tests — defaults to the hub's publishDiagnosticsBatch. */
  publish?(projectId: number, frames: DiagnosticsFrame[]): void;
}

export interface ServerDiagnosticsBatcher {
  enqueue(projectId: number, absPath: string, serverId: string, diagnostics: LspDiagnostic[]): void;
  /** Flush now (one project, or all) — for tests and shutdown paths. */
  flush(projectId?: number): void;
}

function rangeFrom(r?: LspRange0): DiagnosticsFrame['diagnostics'][number]['range'] {
  return r
    ? { start: fromLsp(r.start), end: fromLsp(r.end) }
    : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
}

export function createServerDiagnosticsBatcher(deps: ServerDiagnosticsBatcherDeps): ServerDiagnosticsBatcher {
  const publish = deps.publish ?? publishDiagnosticsBatch;
  const pending = new Map<number, Map<string, PendingFile>>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const flushProject = (projectId: number): void => {
    const timer = timers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(projectId);
    }
    const files = pending.get(projectId);
    if (!files || files.size === 0) return;
    pending.delete(projectId);
    const root = deps.resolveRoot(projectId);
    if (!root) return; // project gone — drop silently
    const frames: DiagnosticsFrame[] = [];
    for (const [absPath, { serverId, diagnostics }] of files) {
      const rel = absToRel(root, absPath);
      if (!rel || deps.includeFile?.(projectId, rel, serverId) === false) continue;
      // Clear the tree-sitter syntax layer for the file — the server's answer
      // supersedes it (same contract as the old direct path).
      frames.push({ file: rel, source: 'syntax', diagnostics: [] });
      frames.push({
        file: rel,
        source: `lsp:${serverId}`,
        diagnostics: diagnostics.map((d) => ({
          file: rel,
          range: rangeFrom(d.range),
          severity: mapSeverity(d.severity),
          message: d.message,
          source: d.source ?? serverId,
          code: d.code,
        })),
      });
    }
    if (frames.length > 0) publish(projectId, frames);
  };

  return {
    enqueue(projectId, absPath, serverId, diagnostics) {
      let files = pending.get(projectId);
      if (!files) {
        files = new Map();
        pending.set(projectId, files);
      }
      files.set(absPath, { serverId, diagnostics });
      if (files.size >= MAX_PENDING_FILES || FLUSH_MS === 0) {
        flushProject(projectId);
        return;
      }
      if (!timers.has(projectId)) {
        const timer = setTimeout(() => flushProject(projectId), FLUSH_MS);
        timer.unref?.();
        timers.set(projectId, timer);
      }
    },
    flush(projectId) {
      if (projectId !== undefined) {
        flushProject(projectId);
        return;
      }
      for (const id of [...pending.keys()]) flushProject(id);
    },
  };
}

/**
 * External-linter scheduler — a diagnostics producer that mirrors the TS/syntax
 * producers (publish straight to the hub; only external LSP needs the batcher).
 *
 * Wiring: `startLintService(db)` (once, guarded) subscribes to the document
 * store. On open/change it debounces per (project,file), then runs every
 * applicable+installed linter over the unsaved buffer and publishes a
 * `lint:${tool}` frame each. A newer edit cancels the in-flight run
 * (latest-wins) via AbortController. Skips entirely when no editor/Problems
 * panel is listening. The last run per (project,file,tool) is cached for the
 * A6 quick-fix seam.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import { ensureDataDir } from '@mcp/shared/utils/config.js';
import { onDocEvent, getDoc } from '../lsp/document-store.js';
import { publishDiagnostics, hasDiagnosticsSubscribers } from '../lsp/diagnostics-hub.js';
import { toolsForLanguage } from './tool-registry.js';
import { runLintTool } from './runner.js';
import { sarifToDiagnostics, type SarifRun } from './sarif.js';

const LINT_DEBOUNCE_MS = (() => {
  const v = Number(process.env.MCP_LINT_DEBOUNCE_MS);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  ctrl?: AbortController;
}

const pending = new Map<string, Pending>();
/** key `${projectId}:${file}:${tool}` → last run, for the quick-fix seam (A6). */
const lastRuns = new Map<string, SarifRun>();
let started = false;

const keyOf = (projectId: number, file: string) => `${projectId}:${file}`;

/** Last cached lint run for a (project,file,tool) — consumed by A6 codeActions. */
export function getLastLintRun(projectId: number, file: string, tool: string): SarifRun | undefined {
  return lastRuns.get(`${projectId}:${file}:${tool}`);
}

function cancel(key: string): void {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  p.ctrl?.abort();
  pending.delete(key);
}

function schedule(db: CodeIndexDB, managedDir: string, projectId: number, file: string, languageId: string): void {
  if (toolsForLanguage(languageId).length === 0) return;
  const key = keyOf(projectId, file);
  // A new edit supersedes the pending debounce AND any in-flight run.
  cancel(key);
  const timer = setTimeout(() => {
    void runFor(db, managedDir, projectId, file, languageId, key);
  }, LINT_DEBOUNCE_MS);
  timer.unref?.();
  pending.set(key, { timer });
}

async function runFor(
  db: CodeIndexDB, managedDir: string, projectId: number, file: string, languageId: string, key: string,
): Promise<void> {
  if (!hasDiagnosticsSubscribers(projectId)) { pending.delete(key); return; }
  const root = db.getProject(projectId)?.root_path;
  const content = getDoc(projectId, file)?.content;
  if (!root || content === undefined) { pending.delete(key); return; }

  const ctrl = new AbortController();
  pending.set(key, { timer: pending.get(key)!.timer, ctrl });

  await Promise.all(toolsForLanguage(languageId).map(async (spec) => {
    const run = await runLintTool({ db, projectId, root, managedDir, spec, relFile: file, content, signal: ctrl.signal });
    if (ctrl.signal.aborted || !run) return; // superseded or errored — keep prior diagnostics
    lastRuns.set(`${projectId}:${file}:${spec.id}`, run);
    // `diagnostics: []` clears the file for this tool when it's now clean.
    publishDiagnostics(projectId, {
      file, source: `lint:${spec.id}`, diagnostics: sarifToDiagnostics(run, file),
    });
  }));

  if (pending.get(key)?.ctrl === ctrl) pending.delete(key);
}

/** Subscribe the linter producer to the document store. Idempotent (Electron dual-instance). */
export function startLintService(db: CodeIndexDB): void {
  if (started) return;
  started = true;
  const managedDir = ensureDataDir();
  onDocEvent(({ projectId, file, doc, kind }) => {
    const key = keyOf(projectId, file);
    if (kind === 'close') {
      cancel(key);
      for (const spec of toolsForLanguage(doc.languageId)) lastRuns.delete(`${projectId}:${file}:${spec.id}`);
      return;
    }
    schedule(db, managedDir, projectId, file, doc.languageId);
  });
}

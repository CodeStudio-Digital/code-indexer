/**
 * Handlers for the `lsp` namespace — the language-intelligence router.
 *
 * Stateful document sync (didOpen/didChange/didClose → document-store) feeds
 * every backend; position-based calls carry only `{file, position}` now
 * (`content` remains accepted for backwards compat). Dispatch per language:
 *
 *   ts/js            → in-process TS service (kept — fast and project-aware)
 *   php/python/...   → external LSP servers (Onda 3, via the same router)
 *   everything else  → index fallback (structural index: def/refs/completion/
 *                      hover for all tree-sitter languages, offline, $0)
 *
 * Diagnostics are PUSHED via `diagnosticsStream` (diagnostics-hub): the TS
 * backend publishes ~500ms after a didChange; the renderer's 1s polling
 * loop is gone. All cross-cutting state lives in module singletons —
 * `createLspHandlers(deps)` is instantiated twice on Electron (IPC mount +
 * Hono dispatch fallback).
 */

import {
  ApiError,
  type LspApi,
  type LspLocation,
  type CompletionItem,
  type HoverInfo,
  type DiagnosticItem,
} from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import type { HandlerDeps } from '../types.js';
import { openDoc, changeDoc, closeDoc, getDoc } from './document-store.js';
import { publishDiagnostics, subscribeDiagnostics, hasDiagnosticsSubscribers } from './diagnostics-hub.js';
import { subscribeServerStatus } from './server-status-hub.js';
import {
  ensureLspManager,
  serverCompletion,
  serverDefinition,
  serverHover,
  serverReferences,
  serverResolveCompletion,
  serverStatusFor,
} from './server-backend.js';
import { installServer, listServers as listLspServers, removeServer as removeLspServer } from '@mcp/services/lsp/server-installer.js';
import { createInProcessLspExecutor } from './executor-inproc.js';
import { getLspExecutor } from './executor-holder.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';

const TS_DIAG_DEBOUNCE_MS = 500;
/** Module singleton — debounce timers survive the dual handler instances. */
const tsDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function createLspHandlers(deps: HandlerDeps): LspApi {
  const { db } = deps;

  // Synchronous compute goes through the executor: the worker-backed one
  // from the holder when server.ts wired it, else this local in-process
  // default (identical code — see executor-inproc.ts).
  const inproc = createInProcessLspExecutor(db);
  const exec = (): LspBackendExecutor => getLspExecutor() ?? inproc;

  function requireProjectRoot(projectId: number): string {
    const project = db.getProject(projectId);
    if (!project) throw new ApiError('not_found', 404, 'project not found');
    return project.root_path;
  }

  /** Op context for the executor; docVersion guards worker-mirror staleness. */
  function opCtx(
    projectId: number, root: string, file: string,
    position?: { line: number; column: number }, content?: string, languageId?: string,
  ): LspOpCtx {
    return { projectId, root, file, position, content, languageId, docVersion: getDoc(projectId, file)?.version };
  }

  /** Debounced TS diagnostics → hub (rel path = the editor's model key). */
  function scheduleTsDiagnostics(projectId: number, root: string, file: string): void {
    if (!isTsFile(file) || !hasDiagnosticsSubscribers(projectId)) return;
    const k = `${projectId}:${file}`;
    const prev = tsDiagTimers.get(k);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      tsDiagTimers.delete(k);
      exec().tsDiagnostics(opCtx(projectId, root, file))
        .then((diags) => {
          publishDiagnostics(projectId, {
            file,
            source: 'ts',
            diagnostics: diags.map<DiagnosticItem>((d) => ({
              file,
              range: { start: { line: d.line, column: d.column }, end: { line: d.line, column: d.column } },
              severity: d.severity,
              message: d.message,
              source: 'ts',
              code: d.code,
            })),
          });
        })
        .catch(() => undefined); // diagnostics are best-effort
    }, TS_DIAG_DEBOUNCE_MS);
    timer.unref?.();
    tsDiagTimers.set(k, timer);
  }

  return {
    async didOpen({ projectId, file, languageId, version, content }) {
      const root = requireProjectRoot(projectId);
      openDoc(projectId, file, languageId || languageIdForPath(file), version, content);
      // No eager TS sync here — every executor op syncs the live buffer at
      // use time, and the diagnostics tick below does too.
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      return { ok: true as const };
    },

    async didChange({ projectId, file, version, changes }) {
      const root = requireProjectRoot(projectId);
      if (!changeDoc(projectId, file, version, changes)) return { resync: true as const };
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      return { ok: true as const };
    },

    async didClose({ projectId, file }) {
      closeDoc(projectId, file);
      const k = `${projectId}:${file}`;
      const timer = tsDiagTimers.get(k);
      if (timer) { clearTimeout(timer); tsDiagTimers.delete(k); }
      // Clear markers on the renderer side too.
      publishDiagnostics(projectId, { file, source: 'ts', diagnostics: [] });
      return { ok: true as const };
    },

    diagnosticsStream({ projectId }) {
      requireProjectRoot(projectId);
      return subscribeDiagnostics(projectId);
    },

    async completion({ projectId, file, position, content, context }) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        // Race the LSP server against a soft deadline. A WARM server answers
        // in ~30ms and wins; while it's still indexing (or blocked) the
        // structural index fills the gap INSTANTLY instead of stalling on the
        // server's 5s hard timeout. Dumb→smart per keystroke: the provider
        // marks results incomplete so Monaco re-queries once the server warms.
        const serverP = serverCompletion(db, projectId, root, file, lang, position, context);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const SOFT = Symbol('lsp-soft-deadline');
        const raced = await Promise.race([
          serverP,
          new Promise<typeof SOFT>((r) => { timer = setTimeout(() => r(SOFT), 600); }),
        ]);
        if (timer) clearTimeout(timer);
        if (raced !== SOFT && raced && raced.length > 0) return raced as CompletionItem[];
        void serverP.catch(() => undefined); // abandoned if it lost the race
        return exec().fallbackCompletion(opCtx(projectId, root, file, position, undefined, lang));
      }
      const entries = await exec().tsCompletions(opCtx(projectId, root, file, position, content));
      return entries.map<CompletionItem>((e) => ({
        label: e.name,
        kind: e.kind,
        detail: e.detail,
        insertText: e.insertText,
        // The TS service already ranks (sortText) and marks snippets — pass
        // them through or Monaco re-sorts alphabetically (free TS/JS win).
        sortText: e.sortText,
        insertTextFormat: e.isSnippet ? 2 : 1,
      }));
    },

    async resolveCompletion({ projectId, file, item }) {
      // Only external LSP servers defer fields to resolve; TS service and
      // index-fallback items are already complete.
      if (isTsFile(file)) return null;
      requireProjectRoot(projectId);
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      return serverResolveCompletion(db, projectId, lang, item);
    },

    async hover({ projectId, file, position, content }) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        // undefined = no server reachable → index fallback; null = the
        // server answered "nothing here" (authoritative).
        const viaServer = await serverHover(db, projectId, root, file, lang, position);
        if (viaServer !== undefined) return viaServer;
        return exec().fallbackHover(opCtx(projectId, root, file, position, undefined, lang));
      }
      const info = await exec().tsHover(opCtx(projectId, root, file, position, content));
      if (!info) return null;
      const lines: string[] = [];
      if (info.displayString) lines.push('```ts\n' + info.displayString + '\n```');
      if (info.documentation) lines.push(info.documentation);
      const hover: HoverInfo = { contents: lines.join('\n\n') };
      return hover;
    },

    async definition({ projectId, file, position, content }) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        const viaServer = await serverDefinition(db, projectId, root, file, lang, position);
        if (viaServer && viaServer.length > 0) return viaServer;
        return exec().fallbackDefinition(opCtx(projectId, root, file, position));
      }
      const { targets } = await exec().tsDefinition(opCtx(projectId, root, file, position, content));
      return targets.map<LspLocation>((t) => ({
        file: t.file,
        range: { start: { line: t.line, column: t.column }, end: { line: t.line, column: t.column } },
      }));
    },

    async references({ projectId, file, position, content }) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        const viaServer = await serverReferences(db, projectId, root, file, lang, position);
        if (viaServer && viaServer.length > 0) return viaServer;
        return exec().fallbackReferences(opCtx(projectId, root, file, position));
      }
      const { references } = await exec().tsReferences(opCtx(projectId, root, file, position, content));
      return references.map<LspLocation>((r) => ({
        file: r.file,
        range: { start: { line: r.line, column: r.column }, end: { line: r.line, column: r.column } },
      }));
    },

    async diagnostics({ projectId, file, content }) {
      // Legacy pull path — kept for agent tools and HTTP compat. The editor
      // uses diagnosticsStream. NOTE: this path reports ABSOLUTE d.file
      // (agent-facing) while the push path reports the rel model key.
      if (!file) return [];
      if (!isTsFile(file)) return [];
      const root = requireProjectRoot(projectId);
      const diags = await exec().tsDiagnostics(opCtx(projectId, root, file, undefined, content));
      return diags.map<DiagnosticItem>((d) => ({
        file: d.file,
        range: {
          start: { line: d.line, column: d.column },
          end: { line: d.line, column: d.column },
        },
        severity: d.severity,
        message: d.message,
        source: 'ts',
        code: d.code,
      }));
    },

    async semanticTokens({ projectId, file, content }) {
      // TS-only — JS gets the same TS service so it still works, but
      // non-script files (md, css, etc.) skip entirely.
      if (!isTsFile(file)) return { data: [] };
      const root = requireProjectRoot(projectId);
      const data = await exec().tsSemanticTokens(opCtx(projectId, root, file, undefined, content));
      return { data };
    },

    async serverStatus({ projectId, languageId }) {
      requireProjectRoot(projectId);
      return serverStatusFor(db, projectId, languageId);
    },

    serverStatusStream({ projectId }) {
      requireProjectRoot(projectId);
      // Ensure the manager (and its onStateChange → hub wiring) exists so
      // transitions actually reach this subscriber.
      ensureLspManager(db);
      return subscribeServerStatus(projectId);
    },

    async listServers() {
      return listLspServers();
    },

    async instances() {
      return ensureLspManager(db).listInstances();
    },

    installServerStream({ serverId }) {
      // AsyncGenerator IS an AsyncIterable — streamed as-is (MessagePort on
      // Electron via the Stream suffix; SSE route for browser dev).
      return installServer(serverId);
    },

    async removeServer({ serverId }) {
      return { ok: removeLspServer(serverId) };
    },

    async restartServer({ projectId, serverId }) {
      requireProjectRoot(projectId);
      await ensureLspManager(db).restart(projectId, serverId);
      return { ok: true as const };
    },

    async rename(_input) {
      // The TS service doesn't expose a rename surface yet — `getEditsForRefactor`
      // can do it but plumbing is non-trivial. Throw 501 until the IDE actually
      // wires a rename UI (post-MVP).
      throw new ApiError('not_implemented', 501, 'lsp.rename lands post-MVP');
    },

    async codeActions(_input) {
      throw new ApiError('not_implemented', 501, 'lsp.codeActions lands post-MVP');
    },
  } satisfies LspApi;
}

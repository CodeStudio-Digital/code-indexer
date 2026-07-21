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
  type CodeActionDTO,
  type LspApi,
  type LspLocation,
  type CompletionItem,
  type HoverInfo,
  type DiagnosticItem,
} from '@mcp/api-bus';
import { isTsFile } from '@mcp/code-agent/lsp/ts-service.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import type { HandlerDeps } from '../types.js';
import { openDoc, changeDocWithSession, closeDoc, documentSyncCounters, getDoc } from './document-store.js';
import { publishDiagnostics, subscribeDiagnostics } from './diagnostics-hub.js';
import { subscribeServerStatus } from './server-status-hub.js';
import {
  ensureLspManager,
  serverCompletion,
  serverCodeActions,
  serverDefinition,
  serverHover,
  serverReferences,
  serverResolveCodeAction,
  serverResolveCompletion,
  serverExecuteCodeAction,
  serverSemanticTokens,
  serverStatusFor,
} from './server-backend.js';
import { installServer, listServers as listLspServers, removeServer as removeLspServer } from '@mcp/services/lsp/server-installer.js';
import { serverForLanguage } from '@mcp/services/lsp/server-registry.js';
import { invalidateLspRuntimeCache } from './lsp-runtime.js';
import { writeLanguageLevel, parseLanguageLevels, defaultLevelFor } from '@mcp/shared/utils/language-levels.js';
import { detectLanguageLevel } from './language-level-detect.js';
import { createInProcessLspExecutor } from './executor-inproc.js';
import { getLspExecutor } from './executor-holder.js';
import type { LspBackendExecutor, LspOpCtx } from './executor-types.js';
import { syntaxDiagnosticsFor } from './syntax-diagnostics.js';
import { createEditorOpsHandlers } from './editor-ops-handlers.js';
import { startLintService } from '../lint/service.js';

const TS_DIAG_DEBOUNCE_MS = 500;
/** Module singleton — debounce timers survive the dual handler instances. */
const tsDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();
const syntaxDiagTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Fase 0 (observability do overhaul do editor) — log estruturado do P2, gated por
 * env (MCP_LSP_DEBUG=1). Sai no stderr do main process; uma linha por completion
 * não-TS classifica a fonte (server / soft-timeout / fallback) + estado do server.
 */
function lspLog(msg: string): void {
  if (process.env.MCP_LSP_DEBUG === '1') console.error(msg);
}

/** Janela em que a completion PREFERE o server antes de mesclar o índice (W3).
 *  Era 600ms hardcoded — apertado p/ cold-boot Windows. Knob MCP_LSP_SOFT_DEADLINE_MS. */
function softDeadlineMs(): number {
  const v = Number(process.env.MCP_LSP_SOFT_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : 1500;
}

const labelKey = (l: CompletionItem['label']): string => l;

/**
 * Mescla completions do server (intelephense/pyright) + índice estrutural, dedup por
 * (label, kind). O server vem primeiro (tem auto-import via resolve); o índice preenche
 * o que o server não cobriu. É o que GARANTE que os símbolos do projeto apareçam mesmo
 * se o server falhar, retornar vazio, ou mandar itens que o Monaco descarta (P2).
 */
function mergeCompletions(server: CompletionItem[], index: CompletionItem[]): CompletionItem[] {
  if (index.length === 0) return server;
  if (server.length === 0) return index;
  const seen = new Set(server.map((i) => `${labelKey(i.label)}\0${i.kind}`));
  const out = [...server];
  for (const i of index) {
    const k = `${labelKey(i.label)}\0${i.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out.slice(0, 200);
}

export function createLspHandlers(deps: HandlerDeps): LspApi {
  const { db } = deps;

  // External-linter diagnostics producer (stylelint/eslint over the unsaved
  // buffer → `lint:${tool}` frames). Idempotent: subscribes the document store
  // once even though this factory runs twice on Electron.
  startLintService(db);

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
    range?: { start: { line: number; column: number }; end: { line: number; column: number } },
  ): LspOpCtx {
    return { projectId, root, file, position, range, content, languageId, docVersion: getDoc(projectId, file)?.version };
  }

  /** Debounced TS diagnostics → hub (rel path = the editor's model key). */
  function scheduleTsDiagnostics(projectId: number, root: string, file: string): void {
    if (!isTsFile(file)) return;
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

  /** Fallback syntax diagnostics while there is no ready external LSP. */
  function scheduleSyntaxDiagnostics(projectId: number, file: string, languageId: string): void {
    if (isTsFile(file) || languageId === 'plaintext') return;
    const k = `${projectId}:${file}`;
    const prev = syntaxDiagTimers.get(k);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      syntaxDiagTimers.delete(k);
      const status = ensureLspManager(db).status(projectId, languageId);
      if (status.state === 'ready') {
        publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] });
        return;
      }
      const content = getDoc(projectId, file)?.content;
      if (content === undefined) return;
      syntaxDiagnosticsFor(file, content)
        .then((diagnostics) => publishDiagnostics(projectId, {
          file,
          source: 'syntax',
          diagnostics: diagnostics.map((d) => ({ ...d, file })),
        }))
        .catch(() => publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] }));
    }, TS_DIAG_DEBOUNCE_MS);
    timer.unref?.();
    syntaxDiagTimers.set(k, timer);
  }

  const base = {
    async didOpen({ projectId, file, languageId, version, content, syncSessionId }) {
      const root = requireProjectRoot(projectId);
      const lang = languageId || languageIdForPath(file);
      const accepted = openDoc(projectId, file, lang, version, content, syncSessionId);
      if (!accepted) return { ok: true as const };
      // No eager TS sync here — every executor op syncs the live buffer at
      // use time, and the diagnostics tick below does too.
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      else {
        scheduleSyntaxDiagnostics(projectId, file, lang);
        // Warm lightweight servers only. Heavy interactive-only servers such
        // as OmniSharp reject the `open` intent and stay cold until user input.
        if (process.env.MCP_LSP_WARM_ON_OPEN !== '0') {
          void ensureLspManager(db).acquire(projectId, lang, 'open').catch(() => undefined);
        }
      }
      return { ok: true as const };
    },

    async didChange({ projectId, file, version, changes, syncSessionId }) {
      const root = requireProjectRoot(projectId);
      const changed = changeDocWithSession(projectId, file, version, changes, syncSessionId);
      if (changed === 'stale-session') return { ok: true as const };
      if (changed === 'resync') return { resync: true as const };
      if (isTsFile(file)) scheduleTsDiagnostics(projectId, root, file);
      else {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        scheduleSyntaxDiagnostics(projectId, file, lang);
      }
      return { ok: true as const };
    },

    async didClose({ projectId, file, syncSessionId }) {
      const languageId = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      if (!closeDoc(projectId, file, syncSessionId)) return { ok: true as const };
      const k = `${projectId}:${file}`;
      const timer = tsDiagTimers.get(k);
      if (timer) { clearTimeout(timer); tsDiagTimers.delete(k); }
      const syntaxTimer = syntaxDiagTimers.get(k);
      if (syntaxTimer) { clearTimeout(syntaxTimer); syntaxDiagTimers.delete(k); }
      // Clear markers on the renderer side too.
      publishDiagnostics(projectId, { file, source: 'ts', diagnostics: [] });
      publishDiagnostics(projectId, { file, source: 'syntax', diagnostics: [] });
      const server = serverForLanguage(languageId);
      if (server) publishDiagnostics(projectId, { file, source: `lsp:${server.id}`, diagnostics: [] });
      return { ok: true as const };
    },

    diagnosticsStream({ projectId }) {
      requireProjectRoot(projectId);
      return subscribeDiagnostics(projectId);
    },

    async completion({ projectId, file, position, content, context }, ctx) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        // Race the LSP server against a soft deadline. A WARM server answers
        // in ~30ms and wins; while it's still indexing (or blocked) the
        // structural index fills the gap INSTANTLY instead of stalling on the
        // server's 5s hard timeout. Dumb→smart per keystroke: the provider
        // marks results incomplete so Monaco re-queries once the server warms.
        // Fase 0 — estado do server SEM warm-spawn (status() é puro; serverStatusFor
        // é que dispara o acquire). Usado só para o log de diagnóstico do P2.
        const serverState = ensureLspManager(db).status(projectId, lang).state;
        const t0 = Date.now();
        const serverP = serverCompletion(db, projectId, root, file, lang, position, context, ctx.signal);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const SOFT = Symbol('lsp-soft-deadline');
        const raced = await Promise.race([
          serverP,
          new Promise<typeof SOFT>((r) => { timer = setTimeout(() => r(SOFT), softDeadlineMs()); }),
        ]);
        if (timer) clearTimeout(timer);
        const serverList = raced !== SOFT && raced && 'items' in raced ? raced : null;
        const serverItems = serverList?.items ?? [];
        if (raced === SOFT) void serverP.catch(() => undefined); // abandoned (lost the race)
        // SEMPRE mescla o índice estrutural: os símbolos do PROJETO aparecem mesmo se o
        // server falhar / retornar vazio / mandar itens que o Monaco descarta (P2). A query
        // do índice é barata (b-tree scan). Server tem prioridade (auto-import via resolve).
        const fbItems = await exec().fallbackCompletion(opCtx(projectId, root, file, position, undefined, lang));
        const merged = mergeCompletions(serverItems, fbItems);
        lspLog(
          `[lsp.completion] proj=${projectId} ${lang} file=${file} ` +
          `src=${serverItems.length ? 'server+index' : raced === SOFT ? 'soft-timeout→index' : 'index'} ` +
          `serverState=${serverState} server=${serverItems.length} index=${fbItems.length} warmMs=${Date.now() - t0}`,
        );
        return {
          items: merged.map((item) => ({ ...item, origin: item.origin ?? (serverItems.includes(item) ? 'lsp' : 'index') })),
          isIncomplete: raced === SOFT || !serverList || serverList.isIncomplete,
        };
      }
      const entries = await exec().tsCompletions(opCtx(projectId, root, file, position, content));
      const tsItems = entries.map<CompletionItem>((e) => ({
        label: e.name,
        kind: e.kind,
        detail: e.detail,
        insertText: e.insertText,
        // The TS service already ranks (sortText) and marks snippets — pass
        // them through or Monaco re-sorts alphabetically (free TS/JS win).
        sortText: e.sortText,
        insertTextFormat: e.isSnippet ? 2 : 1,
        // Só candidatos de auto-import (hasAction) carregam `raw` → o renderer resolve
        // só esses. Embutimos a position porque o Monaco não a passa ao resolve.
        raw: e.hasAction ? { name: e.name, source: e.source, data: e.data, position } : undefined,
        origin: 'ts',
      }));
      const lang = languageIdForPath(file);
      const fbItems = await exec().fallbackCompletion(opCtx(projectId, root, file, position, undefined, lang));
      return { items: mergeCompletions(tsItems, fbItems.map((item) => ({ ...item, origin: 'index' as const }))), isIncomplete: false };
    },

    async resolveCompletion({ projectId, file, item }, ctx) {
      const root = requireProjectRoot(projectId);
      if (isTsFile(file)) {
        // TS/JS auto-import: `item` é o `raw` que guardamos na completion
        // (name/source/data/position). Busca os codeActions de import.
        const raw = item as
          | { name?: string; source?: string; data?: unknown; position?: { line: number; column: number } }
          | null;
        if (!raw?.name || !raw.position) return null;
        const details = await exec().tsCompletionDetails({
          ...opCtx(projectId, root, file, raw.position),
          completionEntry: { name: raw.name, source: raw.source, data: raw.data },
        });
        if (!details) return null;
        // kind/label são ignorados no resolve (o renderer só lê additionalTextEdits/
        // detail/documentation e muta o item existente) — placeholder seguro.
        return {
          label: raw.name,
          kind: 'text',
          additionalTextEdits: details.additionalTextEdits,
          detail: details.detail,
          documentation: details.documentation,
        };
      }
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      return serverResolveCompletion(db, projectId, lang, item, ctx.signal);
    },

    async hover({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        // undefined = no server reachable → index fallback; null = the
        // server answered "nothing here" (authoritative).
        const viaServer = await serverHover(db, projectId, root, file, lang, position, ctx.signal);
        if (ctx.signal.aborted) return null;
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

    async definition({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        const viaServer = await serverDefinition(db, projectId, root, file, lang, position, ctx.signal);
        if (ctx.signal.aborted) return [];
        if (viaServer && viaServer.length > 0) return viaServer;
        return exec().fallbackDefinition(opCtx(projectId, root, file, position));
      }
      const { targets } = await exec().tsDefinition(opCtx(projectId, root, file, position, content));
      return targets.map<LspLocation>((t) => ({
        file: t.file,
        range: { start: { line: t.line, column: t.column }, end: { line: t.line, column: t.column } },
      }));
    },

    async references({ projectId, file, position, content }, ctx) {
      const root = requireProjectRoot(projectId);
      if (!isTsFile(file)) {
        const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
        const viaServer = await serverReferences(db, projectId, root, file, lang, position, ctx.signal);
        if (ctx.signal.aborted) return [];
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

    async semanticTokens({ projectId, file, content }, ctx) {
      const root = requireProjectRoot(projectId);
      // TS/JS → the in-process TS service (its tokens already match Monaco's legend).
      if (isTsFile(file)) {
        const data = await exec().tsSemanticTokens(opCtx(projectId, root, file, undefined, content));
        return { data };
      }
      // php/python/… → the language server, remapped onto Monaco's legend. A
      // cold/absent server returns null → empty (Monarch keeps colouring) and
      // Monaco re-requests once the server warms (or on the next edit).
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const viaServer = await serverSemanticTokens(db, projectId, root, file, lang, ctx.signal);
      return viaServer ?? { data: [] };
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
      const counters = documentSyncCounters();
      return ensureLspManager(db).listInstances().map((instance) => ({ ...instance, counters }));
    },

    installServerStream({ serverId }) {
      // AsyncGenerator IS an AsyncIterable — streamed as-is (MessagePort on
      // Electron via the Stream suffix; SSE route for browser dev).
      const manager = ensureLspManager(db);
      return (async function* installAndRestart() {
        for await (const frame of installServer(serverId)) {
          // JVM agents are startup-only. Restart every live instance before
          // publishing `done`, so the install CTA's ready poll cannot reuse a
          // pre-Lombok JDT LS process.
          if (frame.phase === 'done') {
            invalidateLspRuntimeCache();
            const projects = manager.listInstances()
              .filter((instance) => instance.serverId === serverId)
              .map((instance) => instance.projectId);
            await Promise.allSettled(projects.map((projectId) => manager.restart(projectId, serverId)));
          }
          yield frame;
        }
      })();
    },

    async removeServer({ serverId }) {
      const manager = ensureLspManager(db);
      return { ok: await manager.uninstallServer(serverId, () => removeLspServer(serverId)) };
    },

    async restartServer({ projectId, serverId }) {
      requireProjectRoot(projectId);
      // Manual restart is the user's "try again" after fixing the toolchain —
      // re-detect runtimes instead of serving a cached (possibly stale) miss.
      invalidateLspRuntimeCache();
      await ensureLspManager(db).restart(projectId, serverId);
      return { ok: true as const };
    },

    async setLanguageLevel({ projectId, languageId, level }) {
      requireProjectRoot(projectId);
      const proj = db.getProject(projectId)!; // requireProjectRoot já garantiu existência
      db.updateProject(projectId, {
        language_levels: writeLanguageLevel(proj.language_levels, languageId, level),
      });
      // Restart aplica a versão nova (server relê a config no próximo spawn).
      const def = serverForLanguage(languageId);
      if (def) await ensureLspManager(db).restart(projectId, def.id);
      return { ok: true as const };
    },

    async languageLevels({ projectId }) {
      const proj = db.getProject(projectId);
      if (!proj) throw new ApiError('not_found', 404, 'project not found');
      const explicit = parseLanguageLevels(proj.language_levels);
      const compute = (lang: 'php' | 'python') => {
        const exp = explicit[lang];
        const det = exp ? undefined : detectLanguageLevel(proj.root_path, lang);
        const level = exp ?? det ?? defaultLevelFor(lang);
        const source: 'explicit' | 'detected' | 'default' = exp ? 'explicit' : det ? 'detected' : 'default';
        return { level, source };
      };
      return { php: compute('php'), python: compute('python') };
    },

    async codeActions({ projectId, file, range, trigger }, ctx) {
      const root = requireProjectRoot(projectId);
      if (isTsFile(file)) {
        return exec().tsCodeActions(opCtx(projectId, root, file, undefined, undefined, languageIdForPath(file), range));
      }
      const lang = getDoc(projectId, file)?.languageId ?? languageIdForPath(file);
      const viaServer = await serverCodeActions(db, projectId, root, file, lang, range, trigger ?? 'invoke', ctx.signal);
      return (viaServer ?? []) satisfies CodeActionDTO[];
    },

    async resolveCodeAction({ projectId, action }, ctx) {
      requireProjectRoot(projectId);
      return serverResolveCodeAction(db, projectId, action, ctx.signal);
    },

    async executeCodeAction({ projectId, action }) {
      requireProjectRoot(projectId);
      return serverExecuteCodeAction(db, projectId, action);
    },
  } satisfies Omit<
    LspApi,
    'rename' | 'signatureHelp' | 'documentSymbols' | 'formatting' | 'organizeImports' | 'implementation'
  >;

  // Editor refactor ops (rename / signatureHelp / documentSymbols /
  // formatting / organizeImports / implementation) live in their own
  // factory — the shared closures ride along.
  return {
    ...base,
    ...createEditorOpsHandlers(deps, { requireProjectRoot, opCtx, exec }),
  } satisfies LspApi;
}

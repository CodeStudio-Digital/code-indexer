/**
 * Bridge between the lsp router and real LSP servers: wires the
 * LspServerManager singleton (node resolution, doc replay, diagnostics →
 * hub), forwards document-store events, and translates LSP wire shapes
 * into this app's contracts. Every op returns null when no server can
 * answer — the router then falls to the index fallback.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  CodeActionDTO,
  CompletionItem,
  LspCompletionList,
  DocChange,
  HoverInfo,
  LspLocation,
  TextEditDTO,
  WorkspaceEditDTO,
} from '@mcp/api-bus';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { parseRuntimeVersions } from '@mcp/shared/utils/runtime-versions.js';
// Canonicalizador ÚNICO (W3): didOpen e completion passam a usar a MESMA chave de path
// (forward-slash + drive lowercase), senão o intelephense não reconhece o arquivo no Windows.
import {
  canonicalAbs as normAbs,
  relToAbsCanonical as relToAbs,
} from '@mcp/shared/utils/fs-canonical.js';
import {
  getLspServerManager,
  type LspAcquireIntent,
  type LspServerManager,
} from '@mcp/services/lsp/lsp-server-manager.js';
import {
  fromLsp,
  hoverToMarkdown,
  mapCompletionKind,
  uriToPath,
  type LspCompletionItem,
  type LspCodeAction,
  type LspHover,
  type LspLocationLike,
  type LspRange0,
  type LspTextEdit,
  type LspTextDocumentEdit,
  type LspWorkspaceEdit,
} from '@mcp/services/lsp/lsp-protocol.js';
import { serverForLanguage, serverById } from '@mcp/services/lsp/server-registry.js';
import { remapSemanticTokens, MONACO_SEMANTIC_LEGEND } from './semantic-tokens-remap.js';
import { mapLspConfigSection, languageLevelForServer } from '@mcp/services/lsp/lsp-config-map.js';
import { parseLanguageLevels } from '@mcp/shared/utils/language-levels.js';
import { detectLanguageLevel } from './language-level-detect.js';
import { resolveProjectNodeBinDir } from '../runtime/node-manager.js';
import { loadedExtensionsForRuntimeId } from '../runtime/php-manager.js';
import { docsForProject, getDoc, onDocEvent } from './document-store.js';
import { createServerDiagnosticsBatcher, type ServerDiagnosticsBatcher } from './diagnostics-batcher.js';
import { publishServerStatus } from './server-status-hub.js';
import { resolveLspRuntime } from './lsp-runtime.js';

let wired = false;
/** Module singleton (dual handler factories) — resolves roots ONCE per flush. */
let diagBatcher: ServerDiagnosticsBatcher | null = null;

// normAbs / relToAbs vêm do canonicalizador único (@mcp/shared/utils/fs-canonical),
// importados com alias acima — a chave de path agora é idêntica em didOpen e completion.

function rangeFrom(r?: LspRange0): { start: { line: number; column: number }; end: { line: number; column: number } } {
  return r
    ? { start: fromLsp(r.start), end: fromLsp(r.end) }
    : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
}

function textEditFrom(e: LspTextEdit): TextEditDTO {
  return { range: rangeFrom(e.range), newText: e.newText };
}

function isTextDocumentEdit(entry: unknown): entry is LspTextDocumentEdit {
  if (!entry || typeof entry !== 'object') return false;
  const record = entry as Record<string, unknown>;
  const textDocument = record.textDocument as Record<string, unknown> | undefined;
  return !!textDocument && typeof textDocument.uri === 'string' && Array.isArray(record.edits);
}

export function mapServerWorkspaceEdit(edit: LspWorkspaceEdit | undefined): WorkspaceEditDTO | undefined {
  if (!edit) return undefined;
  const changes: Record<string, TextEditDTO[]> = {};
  const push = (uri: string, edits: LspTextEdit[]): void => {
    if (!uri.toLowerCase().startsWith('file:')) return;
    const file = uriToPath(uri);
    const mapped = edits.map(textEditFrom);
    if (mapped.length > 0) changes[file] = [...(changes[file] ?? []), ...mapped];
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    if (Array.isArray(edits)) push(uri, edits);
  }
  for (const entry of edit.documentChanges ?? []) {
    if (isTextDocumentEdit(entry)) push(entry.textDocument.uri, entry.edits);
  }

  return Object.keys(changes).length > 0 ? { changes } : undefined;
}

export function mapServerCodeActions(raw: unknown, originServerId?: string): CodeActionDTO[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: CodeActionDTO[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const action = entry as LspCodeAction;
    if (typeof action.title !== 'string' || !action.title.trim()) continue;
    if (action.disabled) continue;
    const edit = mapServerWorkspaceEdit(action.edit);
    // textDocument/codeAction returns `(Command | CodeAction)[]`. A bare
    // Command carries its command id directly as a string, while a CodeAction
    // nests it in `action.command`.
    const direct = entry as { command?: unknown; arguments?: unknown[] };
    const command = typeof direct.command === 'string'
      ? { command: direct.command, arguments: direct.arguments }
      : action.command?.command
        ? { command: action.command.command, arguments: action.command.arguments }
        : undefined;
    if (!edit && !command && action.data === undefined) continue;
    out.push({
      title: action.title,
      kind: action.kind ?? 'quickfix',
      isPreferred: action.isPreferred || undefined,
      edit,
      command,
      originServerId,
      raw: action,
      needsResolve: !edit && !command && action.data !== undefined,
    });
  }
  return out;
}

/** Singleton wiring — first call hooks document events + diagnostics. */
export function ensureLspManager(db: CodeIndexDB): LspServerManager {
  // Versão da linguagem por projeto (migration 157) → config do server. Rollback: MCP_LSP_LANGUAGE_LEVEL=0.
  const langLevelEnabled = process.env.MCP_LSP_LANGUAGE_LEVEL !== '0';
  // Versão EFETIVA: escolha explícita do usuário OU auto-detect do manifesto (composer.json/pyproject.toml).
  const levelsFor = (projectId: number) => {
    if (!langLevelEnabled) return {};
    const proj = db.getProject(projectId);
    const merged = parseLanguageLevels(proj?.language_levels ?? null);
    const root = proj?.root_path;
    if (!root) return merged;
    for (const lang of ['php', 'python'] as const) {
      if (!merged[lang]) {
        const detected = detectLanguageLevel(root, lang);
        if (detected) merged[lang] = detected;
      }
    }
    return merged;
  };
  const phpExtensionsFor = (projectId: number): string[] => {
    const project = db.getProject(projectId);
    const runtimeId = parseRuntimeVersions(project?.runtime_versions ?? null).php;
    return loadedExtensionsForRuntimeId(runtimeId, mcpDataDir());
  };
  const manager = getLspServerManager({
    resolveNodeBin: (projectId) => {
      try { return resolveProjectNodeBinDir(db, projectId, mcpDataDir()); } catch { return null; }
    },
    resolveRoot: (projectId) => db.getProject(projectId)?.root_path ?? null,
    listProjectRoots: () => db.listProjects().map((project) => project.root_path),
    resolveRuntime: (projectId, requirement) => resolveLspRuntime(db, projectId, requirement),
    resolveLanguageLevel: (projectId, serverId) => languageLevelForServer(serverId, levelsFor(projectId)),
    resolveLspConfig: (projectId, serverId, section) => mapLspConfigSection(
      serverId,
      section,
      levelsFor(projectId),
      serverId === 'intelephense' ? { phpExtensions: phpExtensionsFor(projectId) } : {},
    ),
    docsForReplay: (projectId, languages) =>
      docsForProject(projectId)
        .filter(({ doc }) => languages.includes(doc.languageId))
        .map(({ file, doc }) => ({ file, languageId: doc.languageId, version: doc.version, content: doc.content })),
    // Per-file forwarding is the flood path (OmniSharp can publish for
    // thousands of files after a solution load) — enqueue into the batcher,
    // which resolves the root once and emits ONE hub batch per flush window.
    onDiagnostics: (projectId, absPath, serverId, diagnostics) => {
      diagBatcher ??= createServerDiagnosticsBatcher({
        resolveRoot: (id) => db.getProject(id)?.root_path ?? null,
        includeFile: (id, file, originServerId) => {
          if (originServerId !== 'omnisharp') return true;
          return getDoc(id, file)?.languageId === 'csharp';
        },
      });
      diagBatcher.enqueue(projectId, absPath, serverId, diagnostics);
    },
    // Lifecycle transitions → the live chip. Translate serverId → its
    // primary language (the chip subscribes per languageId) and surface
    // the failure reason. One frame per transition.
    onStateChange: (projectId, serverId, state, reason) => {
      const def = serverById(serverId);
      if (!def) return;
      const info = { id: def.id, label: def.label, version: def.install.version, sizeLabel: def.sizeLabel };
      for (const languageId of def.languages) {
        publishServerStatus(projectId, { languageId, state, server: info, reason });
      }
    },
    log: (msg) => console.error(msg),
  })!;

  if (!wired) {
    wired = true;
    // Forward buffer lifecycle to whichever server owns the language.
    onDocEvent(({ projectId, file, doc, kind, changes }) => {
      if (!serverForLanguage(doc.languageId)) return;
      const root = db.getProject(projectId)?.root_path;
      if (!root) return;
      const abs = relToAbs(root, file);
      if (kind === 'open') {
        // Forward to a warm server, but let heavy interactive-only servers
        // remain cold. A later user-driven spawn replays this stored buffer.
        void manager.acquire(projectId, doc.languageId, 'open').then((acq) => {
          if (acq && acq.handle.state === 'ready') {
            // ensureOpen (not didOpen): on a FRESH spawn the replay already
            // sent didOpen for this doc — ensureOpen is a no-op then (URI já no
            // Set `opened`); for an already-running server it forwards the open.
            // Evita um textDocument/didOpen duplicado no cold-spawn.
            acq.handle.ensureOpen(abs, doc.languageId, doc.version, doc.content);
          }
        });
        return;
      }
      manager.forEachReady(projectId, (handle, def) => {
        if (!def.languages.includes(doc.languageId)) return;
        if (kind === 'change') {
          handle.didChange(abs, doc.version, doc.content, (changes ?? []).map((c: DocChange) => ({
            start: c.range.start, end: c.range.end, text: c.text,
          })));
        } else if (kind === 'close') {
          handle.didClose(abs);
        }
      });
    });
  }
  return manager;
}

const _interactiveDeadlineRaw = Number(process.env.MCP_LSP_INTERACTIVE_DEADLINE_MS);
export const INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS = Number.isFinite(_interactiveDeadlineRaw)
  ? Math.max(0, _interactiveDeadlineRaw)
  : 750;

/**
 * Start/warm a cold language server without pinning an automatic editor RPC to
 * its whole initialize + project-load cycle. Explicit operations such as
 * rename/format still use `manager.acquire()` directly and are allowed to wait.
 */
export async function acquireLspWithDeadline(
  db: CodeIndexDB,
  projectId: number,
  languageId: string,
  deadlineMs = INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  signal?: AbortSignal,
  intent: LspAcquireIntent = 'interactive',
): Promise<Awaited<ReturnType<LspServerManager['acquire']>>> {
  if (signal?.aborted) return null;
  const pending = ensureLspManager(db).acquire(projectId, languageId, intent);
  const timedOut = Symbol('lsp-acquire-deadline');
  const cancelled = Symbol('lsp-acquire-cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const contenders: Array<Promise<Awaited<ReturnType<LspServerManager['acquire']>> | typeof timedOut | typeof cancelled>> = [pending];
  if (deadlineMs > 0) {
    contenders.push(new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), deadlineMs);
      timer.unref?.();
    }));
  }
  if (signal) {
    contenders.push(new Promise<typeof cancelled>((resolve) => {
      onAbort = () => resolve(cancelled);
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  const result = await Promise.race(contenders);
  if (timer) clearTimeout(timer);
  if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  if (result === timedOut || result === cancelled) {
    // The shared manager spawn remains useful: the next invocation will find
    // the server warm. Observe rejection so abandoning this caller is safe.
    void pending.catch(() => undefined);
    return null;
  }
  return result;
}

// ─── Position ops (null = no server answered → router falls back) ──

/** Pure LSP→contract item mapper (exported for tests). 0-based → 1-based. */
export function mapServerCompletionItem(i: LspCompletionItem): CompletionItem {
  // textEdit may be a plain TextEdit (range) or an InsertReplaceEdit
  // (insert/replace). Prefer `replace` — it's authoritative for member
  // completion after `::`/`->` where the span isn't a simple word.
  const te = i.textEdit;
  const editRange = te?.replace ?? te?.range ?? te?.insert;
  // IntelliJ-style right column: Intelephense doesn't send labelDetails — it
  // puts the auto-import as `detail: "use FQN"` (and only brackets the
  // namespace into the label for ambiguous names). Lift that namespace into
  // labelDetails.description (right-aligned, dimmed) and drop the redundant
  // `use …` detail. Other servers (signatures in detail) are untouched.
  let labelDetails = i.labelDetails;
  let detail = i.detail;
  if (!labelDetails && detail && !i.label.includes('[')) {
    const m = /^use\s+(.+)$/.exec(detail.trim());
    const fqn = m?.[1];
    if (fqn && fqn.includes('\\')) {
      labelDetails = { description: fqn.slice(0, fqn.lastIndexOf('\\')) };
      detail = undefined;
    }
  }
  return {
    label: i.label,
    kind: mapCompletionKind(i.kind),
    detail,
    documentation: typeof i.documentation === 'object' ? i.documentation?.value : i.documentation,
    insertText: te?.newText ?? i.insertText ?? i.label,
    additionalTextEdits: i.additionalTextEdits?.map((e) => ({
      range: rangeFrom(e.range),
      newText: e.newText,
    })),
    sortText: i.sortText,
    filterText: i.filterText,
    insertTextFormat: i.insertTextFormat,
    preselect: i.preselect,
    labelDetails,
    commitCharacters: i.commitCharacters,
    textEdit: editRange ? { range: rangeFrom(editRange), newText: te?.newText ?? i.label } : undefined,
    insertReplaceEdit: te?.insert && te.replace ? {
      insert: rangeFrom(te.insert), replace: rangeFrom(te.replace), newText: te.newText,
    } : undefined,
    deprecated: i.deprecated,
    tags: i.tags,
    origin: 'lsp',
    // Echoed back by resolveCompletion — servers defer the auto-import
    // edits to `completionItem/resolve` and need the original item.
    raw: i,
  };
}

const MAX_SERVER_COMPLETIONS = 500;

function localCompletionPrefix(content: string, position: { line: number; column: number }): string {
  const line = content.split(/\r?\n/, position.line)[position.line - 1] ?? '';
  const beforeCursor = line.slice(0, Math.max(0, position.column - 1));
  return beforeCursor.match(/[$\p{L}\p{N}_]+$/u)?.[0] ?? '';
}

/** Filter before truncation while retaining the language server's exact ranking. */
export function filterServerCompletionItems(
  items: LspCompletionItem[],
  content: string,
  position: { line: number; column: number },
): { items: LspCompletionItem[]; truncated: boolean } {
  const rawPrefix = localCompletionPrefix(content, position).toLocaleLowerCase();
  const prefix = rawPrefix.replace(/^\$/, '');
  const filtered = prefix
    ? items.filter((item) => {
      const candidate = (item.filterText ?? item.label).toLocaleLowerCase();
      return candidate.startsWith(rawPrefix) || candidate.replace(/^\$/, '').startsWith(prefix);
    })
    : items;
  return { items: filtered.slice(0, MAX_SERVER_COMPLETIONS), truncated: filtered.length > MAX_SERVER_COMPLETIONS };
}

export async function serverCompletion(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
  context?: { triggerKind: number; triggerCharacter?: string },
  signal?: AbortSignal,
): Promise<LspCompletionList | null> {
  const acq = await acquireLspWithDeadline(db, projectId, languageId, INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS, signal);
  if (!acq) return null;
  const abs = relToAbs(root, file);
  // W3: garante o didOpen (buffer vivo) ANTES da completion — senão o server responde
  // [] para um doc que não conhece (race didOpen→completion / path Windows divergente).
  const liveDoc = getDoc(projectId, file);
  if (liveDoc) acq.handle.ensureOpen(abs, liveDoc.languageId, liveDoc.version, liveDoc.content);
  try {
    const raw = await acq.handle.completion(abs, position, context, signal);
    const items: LspCompletionItem[] = Array.isArray(raw)
      ? raw as LspCompletionItem[]
      : ((raw as { items?: LspCompletionItem[] })?.items ?? []);
    const selected = filterServerCompletionItems(items, liveDoc?.content ?? '', position);
    return {
      items: selected.items.map(mapServerCompletionItem),
      isIncomplete:
        selected.truncated
        || (!Array.isArray(raw) && (raw as { isIncomplete?: boolean })?.isIncomplete === true),
    };
  } catch (err) {
    // Fase 0 — superfície o erro de protocolo do server (gated por MCP_LSP_DEBUG=1)
    // com a cauda do stderr, p/ o doctor diagnosticar P2.
    if (process.env.MCP_LSP_DEBUG === '1') {
      const tail = acq.handle.stderrTail?.slice(-200) ?? '';
      console.error(`[lsp.serverCompletion] proj=${projectId} ${languageId} threw: ${err instanceof Error ? err.message : String(err)}${tail ? ` — stderr: ${tail}` : ''}`);
    }
    return null;
  }
}

/** `completionItem/resolve` round-trip; null = nothing extra to apply. */
export async function serverResolveCompletion(
  db: CodeIndexDB, projectId: number, languageId: string, item: unknown, signal?: AbortSignal,
): Promise<CompletionItem | null> {
  if (!item || typeof item !== 'object') return null;
  const acq = await acquireLspWithDeadline(db, projectId, languageId, 0, signal, 'manual');
  if (!acq) return null;
  try {
    const resolved = await acq.handle.resolveCompletion(item, signal);
    if (!resolved || typeof resolved !== 'object') return null;
    return mapServerCompletionItem(resolved as LspCompletionItem);
  } catch {
    return null;
  }
}

export async function serverHover(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
): Promise<HoverInfo | null | undefined> {
  const acq = await acquireLspWithDeadline(db, projectId, languageId, INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS, signal);
  if (!acq) return undefined; // undefined = no server (fallback); null = server said nothing
  try {
    const raw = (await acq.handle.hover(relToAbs(root, file), position, signal)) as LspHover | null;
    const md = hoverToMarkdown(raw);
    return md ? { contents: md } : null;
  } catch {
    return undefined;
  }
}

/** LSP Location[]/LocationLink[] (or single) → contract locations. Shared with server-backend-ops. */
export function toLocations(raw: unknown): LspLocation[] {
  const arr: LspLocationLike[] = !raw ? [] : Array.isArray(raw) ? raw as LspLocationLike[] : [raw as LspLocationLike];
  return arr
    .map((l) => {
      const uri = l.targetUri ?? l.uri;
      if (!uri || !uri.toLowerCase().startsWith('file:')) return null;
      return { file: uriToPath(uri), range: rangeFrom(l.targetSelectionRange ?? l.range) };
    })
    .filter((x): x is LspLocation => !!x);
}

export async function serverDefinition(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
): Promise<LspLocation[] | null> {
  const acq = await acquireLspWithDeadline(db, projectId, languageId, 0, signal, 'manual');
  if (!acq) return null;
  try {
    return toLocations(await acq.handle.definition(relToAbs(root, file), position, signal));
  } catch {
    return null;
  }
}

export async function serverReferences(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
  signal?: AbortSignal,
): Promise<LspLocation[] | null> {
  const acq = await acquireLspWithDeadline(db, projectId, languageId, 0, signal, 'manual');
  if (!acq) return null;
  try {
    return toLocations(await acq.handle.references(relToAbs(root, file), position, signal));
  } catch {
    return null;
  }
}

/**
 * Semantic tokens via the language server (intelephense/pyright/…), remapped
 * onto Monaco's legend. null = no server / no provider → router falls back to
 * `{ data: [] }` (Monarch keeps colouring). The server encodes against its own
 * legend, so we MUST translate before handing the stream to Monaco.
 */
export async function serverSemanticTokens(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  signal?: AbortSignal,
): Promise<{ data: number[] } | null> {
  const acq = await acquireLspWithDeadline(
    db, projectId, languageId, INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS, signal, 'background',
  );
  if (!acq) return null;
  const legend = acq.handle.semanticTokensLegend();
  if (!legend) return null; // server doesn't advertise semantic tokens
  const abs = relToAbs(root, file);
  // W3: ensure the live buffer is open before requesting — else the server
  // answers for a doc it doesn't know (race / Windows path divergence).
  const live = getDoc(projectId, file);
  if (live) acq.handle.ensureOpen(abs, live.languageId, live.version, live.content);
  try {
    const raw = (await acq.handle.semanticTokens(abs, signal)) as { data?: number[] } | null;
    if (!raw?.data || raw.data.length === 0) return null;
    return { data: remapSemanticTokens(raw.data, legend, MONACO_SEMANTIC_LEGEND) };
  } catch {
    return null;
  }
}

const _deadlineRaw = Number(process.env.MCP_LSP_CODEACTION_DEADLINE_MS);
const CODEACTION_DEADLINE_MS = Number.isFinite(_deadlineRaw) ? _deadlineRaw : 600; // NaN-safe

export async function serverCodeActions(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  range: { start: { line: number; column: number }; end: { line: number; column: number } },
  origin: 'auto' | 'invoke' = 'invoke',
  signal?: AbortSignal,
): Promise<CodeActionDTO[] | null> {
  const automaticController = origin === 'auto' ? new AbortController() : null;
  const forwardAbort = automaticController && signal
    ? () => automaticController.abort(signal.reason)
    : undefined;
  if (forwardAbort) signal!.addEventListener('abort', forwardAbort, { once: true });
  if (automaticController && signal?.aborted) automaticController.abort(signal.reason);
  const budget = automaticController ? setTimeout(() => automaticController.abort(), 750) : undefined;
  budget?.unref?.();
  const requestSignal = automaticController?.signal ?? signal;
  // A cold server spawn+init is 1-2s; don't let it freeze the lightbulb.
  // Race `acquire` against a short deadline — on timeout return null (empty
  // lightbulb) while the spawn keeps running in the background, so the NEXT
  // invocation hits a warm server. Mirrors completion()'s soft deadline.
  try {
    const acq = await acquireLspWithDeadline(
      db,
      projectId,
      languageId,
      CODEACTION_DEADLINE_MS,
      requestSignal,
      origin === 'auto' ? 'background' : 'manual',
    );
    if (!acq) return null;
    const abs = relToAbs(root, file);
    const liveDoc = getDoc(projectId, file);
    if (liveDoc) acq.handle.ensureOpen(abs, liveDoc.languageId, liveDoc.version, liveDoc.content);
    return mapServerCodeActions(
      await acq.handle.codeActions(abs, range, undefined, { origin, signal: requestSignal }),
      acq.def.id,
    );
  } catch {
    return null;
  } finally {
    if (budget) clearTimeout(budget);
    if (forwardAbort) signal!.removeEventListener('abort', forwardAbort);
  }
}

export async function serverResolveCodeAction(
  db: CodeIndexDB, projectId: number, action: CodeActionDTO, signal?: AbortSignal,
): Promise<CodeActionDTO | null> {
  if (!action.originServerId || !action.raw || !action.needsResolve) return action;
  const acq = await ensureLspManager(db).acquireById(projectId, action.originServerId, 'manual');
  if (!acq || !acq.handle.supportsCodeActionResolve()) return action;
  try {
    const resolved = await acq.handle.resolveCodeAction(action.raw, signal);
    return mapServerCodeActions([resolved], acq.def.id)[0] ?? null;
  } catch { return null; }
}

export async function serverExecuteCodeAction(
  db: CodeIndexDB, projectId: number, action: CodeActionDTO,
): Promise<{ ok: true; edit?: WorkspaceEditDTO }> {
  const command = action.command;
  if (!action.originServerId || !command?.command || command.command.length > 256) throw new Error('invalid LSP command');
  if (JSON.stringify(command.arguments ?? []).length > 64_000) throw new Error('LSP command arguments too large');
  const acq = await ensureLspManager(db).acquireById(projectId, action.originServerId, 'manual');
  if (!acq) throw new Error('origin LSP server unavailable');
  const executed = await acq.handle.executeCommand(command.command, command.arguments);
  const changes: WorkspaceEditDTO['changes'] = {};
  for (const rawEdit of executed.workspaceEdits) {
    const mapped = mapServerWorkspaceEdit(rawEdit as LspWorkspaceEdit);
    for (const [file, edits] of Object.entries(mapped?.changes ?? {})) {
      changes[file] = [...(changes[file] ?? []), ...edits];
    }
  }
  const edit = Object.keys(changes).length > 0 ? { changes } : undefined;
  return { ok: true, edit };
}

/** Language status for the editor CTA / StatusBar chip. */
export function serverStatusFor(db: CodeIndexDB, projectId: number, languageId: string) {
  const manager = ensureLspManager(db);
  const s = manager.status(projectId, languageId);
  // Status may warm lightweight servers, but the manager's activation policy
  // keeps heavy interactive-only servers (OmniSharp) installed and idle.
  if (s.state === 'idle' && s.server) {
    void manager.acquire(projectId, languageId, 'status').catch(() => undefined);
  }
  return {
    state: s.state,
    server: s.server
      ? { id: s.server.id, label: s.server.label, version: s.server.install.version, sizeLabel: s.server.sizeLabel }
      : undefined,
    reason: s.reason,
    runtime: s.runtime
      ? {
          kind: s.runtime.kind,
          minMajor: s.runtime.minMajor,
          satisfied: s.runtime.satisfied,
          version: s.runtime.version,
          reason: s.runtime.reason,
        }
      : undefined,
    autoPrompt: process.env.MCP_LSP_AUTO_PROMPT !== '0',
    workspaceMode: s.workspaceMode,
    workspaceReason: s.workspaceReason,
  };
}

export { getDoc };

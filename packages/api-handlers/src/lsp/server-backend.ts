/**
 * Bridge between the lsp router and real LSP servers: wires the
 * LspServerManager singleton (node resolution, doc replay, diagnostics →
 * hub), forwards document-store events, and translates LSP wire shapes
 * into this app's contracts. Every op returns null when no server can
 * answer — the router then falls to the index fallback.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CompletionItem, DocChange, HoverInfo, LspLocation } from '@mcp/api-bus';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import {
  getLspServerManager,
  type LspServerManager,
} from '@mcp/services/lsp/lsp-server-manager.js';
import {
  fromLsp,
  hoverToMarkdown,
  mapCompletionKind,
  mapSeverity,
  uriToPath,
  type LspCompletionItem,
  type LspHover,
  type LspLocationLike,
  type LspRange0,
} from '@mcp/services/lsp/lsp-protocol.js';
import { serverForLanguage, serverById } from '@mcp/services/lsp/server-registry.js';
import { resolveProjectNodeBinDir } from '../runtime/node-manager.js';
import { docsForProject, getDoc, onDocEvent } from './document-store.js';
import { publishDiagnostics } from './diagnostics-hub.js';
import { publishServerStatus } from './server-status-hub.js';

let wired = false;

function normAbs(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
}

function absToRel(root: string, absPath: string): string | null {
  const a = normAbs(absPath);
  const r = normAbs(root).replace(/\/$/, '');
  return a.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? a.slice(r.length + 1) : null;
}

function relToAbs(root: string, rel: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${rel.replace(/\\/g, '/')}`;
}

function rangeFrom(r?: LspRange0): { start: { line: number; column: number }; end: { line: number; column: number } } {
  return r
    ? { start: fromLsp(r.start), end: fromLsp(r.end) }
    : { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };
}

/** Singleton wiring — first call hooks document events + diagnostics. */
export function ensureLspManager(db: CodeIndexDB): LspServerManager {
  const manager = getLspServerManager({
    resolveNodeBin: (projectId) => {
      try { return resolveProjectNodeBinDir(db, projectId, mcpDataDir()); } catch { return null; }
    },
    resolveRoot: (projectId) => db.getProject(projectId)?.root_path ?? null,
    docsForReplay: (projectId, languages) =>
      docsForProject(projectId)
        .filter(({ doc }) => languages.includes(doc.languageId))
        .map(({ file, doc }) => ({ file, languageId: doc.languageId, version: doc.version, content: doc.content })),
    onDiagnostics: (projectId, absPath, serverId, diagnostics) => {
      const root = db.getProject(projectId)?.root_path;
      if (!root) return;
      const rel = absToRel(root, absPath);
      if (!rel) return;
      publishDiagnostics(projectId, {
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
        // Lazy-spawn on first file of the language; the post-spawn replay
        // covers THIS doc too (the store registered it before emitting).
        void manager.acquire(projectId, doc.languageId).then((acq) => {
          if (acq && acq.handle.state === 'ready') {
            // Replay already sent didOpen for store docs on a FRESH spawn;
            // for an already-running server this open must be forwarded.
            acq.handle.didOpen(abs, doc.languageId, doc.version, doc.content);
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
    // Echoed back by resolveCompletion — servers defer the auto-import
    // edits to `completionItem/resolve` and need the original item.
    raw: i,
  };
}

export async function serverCompletion(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
  context?: { triggerKind: number; triggerCharacter?: string },
): Promise<CompletionItem[] | null> {
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return null;
  try {
    const raw = await acq.handle.completion(relToAbs(root, file), position, context);
    const items: LspCompletionItem[] = Array.isArray(raw)
      ? raw as LspCompletionItem[]
      : ((raw as { items?: LspCompletionItem[] })?.items ?? []);
    return items.slice(0, 120).map(mapServerCompletionItem);
  } catch {
    return null;
  }
}

/** `completionItem/resolve` round-trip; null = nothing extra to apply. */
export async function serverResolveCompletion(
  db: CodeIndexDB, projectId: number, languageId: string, item: unknown,
): Promise<CompletionItem | null> {
  if (!item || typeof item !== 'object') return null;
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return null;
  try {
    const resolved = await acq.handle.resolveCompletion(item);
    if (!resolved || typeof resolved !== 'object') return null;
    return mapServerCompletionItem(resolved as LspCompletionItem);
  } catch {
    return null;
  }
}

export async function serverHover(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
): Promise<HoverInfo | null | undefined> {
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return undefined; // undefined = no server (fallback); null = server said nothing
  try {
    const raw = (await acq.handle.hover(relToAbs(root, file), position)) as LspHover | null;
    const md = hoverToMarkdown(raw);
    return md ? { contents: md } : null;
  } catch {
    return undefined;
  }
}

function toLocations(raw: unknown): LspLocation[] {
  const arr: LspLocationLike[] = !raw ? [] : Array.isArray(raw) ? raw as LspLocationLike[] : [raw as LspLocationLike];
  return arr
    .map((l) => {
      const uri = l.targetUri ?? l.uri;
      if (!uri) return null;
      return { file: uriToPath(uri), range: rangeFrom(l.targetSelectionRange ?? l.range) };
    })
    .filter((x): x is LspLocation => !!x);
}

export async function serverDefinition(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
): Promise<LspLocation[] | null> {
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return null;
  try {
    return toLocations(await acq.handle.definition(relToAbs(root, file), position));
  } catch {
    return null;
  }
}

export async function serverReferences(
  db: CodeIndexDB, projectId: number, root: string, file: string, languageId: string,
  position: { line: number; column: number },
): Promise<LspLocation[] | null> {
  const acq = await ensureLspManager(db).acquire(projectId, languageId);
  if (!acq) return null;
  try {
    return toLocations(await acq.handle.references(relToAbs(root, file), position));
  } catch {
    return null;
  }
}

/** Language status for the editor CTA / StatusBar chip. */
export function serverStatusFor(db: CodeIndexDB, projectId: number, languageId: string) {
  const manager = ensureLspManager(db);
  const s = manager.status(projectId, languageId);
  // Warm-spawn: a 'starting' status with a real server means nothing has
  // acquired yet. Kick the spawn fire-and-forget so merely opening a file
  // (the chip polls on activation) reliably starts the server, even if no
  // completion is invoked. acquire de-dupes via entry.spawning; it's a
  // cheap no-op during the failed window (returns null without spawning).
  if (s.state === 'starting' && s.server) {
    void manager.acquire(projectId, languageId).catch(() => undefined);
  }
  return {
    state: s.state,
    server: s.server
      ? { id: s.server.id, label: s.server.label, version: s.server.install.version, sizeLabel: s.server.sizeLabel }
      : undefined,
    reason: s.reason,
    autoPrompt: process.env.MCP_LSP_AUTO_PROMPT !== '0',
  };
}

export { getDoc };

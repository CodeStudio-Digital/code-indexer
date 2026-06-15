/**
 * Live editor buffers, keyed by (projectId, project-relative path).
 *
 * The renderer streams didOpen/didChange/didClose; every language backend
 * (in-process TS service, external LSP servers, index fallback) reads from
 * here instead of receiving the FULL file content on every completion/
 * hover/diagnostics call — the single biggest payload cost of the old
 * design.
 *
 * MODULE SINGLETON by necessity: `createLspHandlers(deps)` is instantiated
 * twice in Electron (IPC mount + Hono dispatch fallback); factory state
 * would split the buffers between the two instances.
 *
 * Delta application is by absolute offset into the PRE-change buffer.
 * Monaco emits the `changes` array sorted by offset DESCENDING with all
 * ranges referring to the pre-event text — applying in the order received
 * is correct (later edits don't shift earlier offsets).
 */
import type { DocChange } from '@mcp/api-bus';

export interface StoredDoc {
  content: string;
  version: number;
  languageId: string;
}

export type DocListener = (e: {
  projectId: number;
  file: string;
  doc: StoredDoc;
  kind: 'open' | 'change' | 'close';
  changes?: DocChange[];
}) => void;

const docs = new Map<string, StoredDoc>();
const listeners = new Set<DocListener>();

const key = (projectId: number, file: string) => `${projectId}:${file}`;

function emit(projectId: number, file: string, doc: StoredDoc, kind: 'open' | 'change' | 'close', changes?: DocChange[]): void {
  for (const fn of listeners) {
    try { fn({ projectId, file, doc, kind, changes }); } catch { /* listeners never break sync */ }
  }
}

/** Subscribe to buffer lifecycle (LSP server forwarding, TS diagnostics). */
export function onDocEvent(fn: DocListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function openDoc(projectId: number, file: string, languageId: string, version: number, content: string): void {
  const doc: StoredDoc = { content, version, languageId };
  docs.set(key(projectId, file), doc);
  emit(projectId, file, doc, 'open');
}

/** Returns false when versions diverged — caller must answer {resync:true}. */
export function changeDoc(projectId: number, file: string, version: number, changes: DocChange[]): boolean {
  const doc = docs.get(key(projectId, file));
  if (!doc) return false;
  // Monaco versions are strictly increasing per model. Equal or older means
  // a duplicate/out-of-order delivery; a gap means we missed a frame. Both
  // are unrecoverable without the full text.
  if (version <= doc.version) return false;
  let content = doc.content;
  for (const c of changes) {
    if (c.rangeOffset < 0 || c.rangeOffset + c.rangeLength > content.length) return false;
    content = content.slice(0, c.rangeOffset) + c.text + content.slice(c.rangeOffset + c.rangeLength);
  }
  doc.content = content;
  doc.version = version;
  emit(projectId, file, doc, 'change', changes);
  return true;
}

export function closeDoc(projectId: number, file: string): void {
  const k = key(projectId, file);
  const doc = docs.get(k);
  if (!doc) return;
  docs.delete(k);
  emit(projectId, file, doc, 'close');
}

export function getDoc(projectId: number, file: string): StoredDoc | undefined {
  return docs.get(key(projectId, file));
}

/** Every open doc across projects (lsp-worker mirror replay on respawn). */
export function allDocs(): Array<{ projectId: number; file: string; doc: StoredDoc }> {
  const out: Array<{ projectId: number; file: string; doc: StoredDoc }> = [];
  for (const [k, doc] of docs) {
    const sep = k.indexOf(':');
    out.push({ projectId: Number(k.slice(0, sep)), file: k.slice(sep + 1), doc });
  }
  return out;
}

/** All open docs of a project (LSP server replay on spawn/restart). */
export function docsForProject(projectId: number): Array<{ file: string; doc: StoredDoc }> {
  const prefix = `${projectId}:`;
  const out: Array<{ file: string; doc: StoredDoc }> = [];
  for (const [k, doc] of docs) {
    if (k.startsWith(prefix)) out.push({ file: k.slice(prefix.length), doc });
  }
  return out;
}

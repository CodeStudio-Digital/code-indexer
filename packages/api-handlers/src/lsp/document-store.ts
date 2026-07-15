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
  /** Optional only for legacy test/fallback producers; renderer sessions always set it. */
  syncSessionId?: string;
}

export type DocChangeResult = 'ok' | 'resync' | 'stale-session';

export type DocListener = (e: {
  projectId: number;
  file: string;
  doc: StoredDoc;
  kind: 'open' | 'change' | 'close';
  changes?: DocChange[];
}) => void;

const docs = new Map<string, StoredDoc>();
// Kept after close as a tombstone: an obsolete session's delayed didOpen must
// not resurrect itself after the newer document was already opened/closed.
const latestSessions = new Map<string, string>();
const listeners = new Set<DocListener>();
const counters = { resync: 0, staleSessionIgnored: 0 };

export function documentSyncCounters(): Readonly<typeof counters> {
  return { ...counters };
}

const key = (projectId: number, file: string) => `${projectId}:${file}`;

function sessionIsOlder(candidate: string, latest: string): boolean {
  // New renderer sessions start with fixed-width base36 time + sequence.
  // Legacy callers remain accepted; they have no comparable generation.
  const ordered = /^[0-9a-z]{10}-[0-9a-z]{6}-/;
  return ordered.test(candidate) && ordered.test(latest) && candidate < latest;
}

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

export function openDoc(
  projectId: number,
  file: string,
  languageId: string,
  version: number,
  content: string,
  syncSessionId = 'legacy',
): boolean {
  const k = key(projectId, file);
  const latest = latestSessions.get(k);
  if (latest && syncSessionId !== latest && sessionIsOlder(syncSessionId, latest)) {
    counters.staleSessionIgnored += 1;
    return false;
  }
  const previous = docs.get(k);
  // Re-open is an authoritative full resync. Explicit close+open prevents a
  // server handle's URI de-duplication from retaining the previous contents.
  if (previous) emit(projectId, file, previous, 'close');
  const doc: StoredDoc = { content, version, languageId, syncSessionId };
  latestSessions.set(k, syncSessionId);
  docs.set(k, doc);
  emit(projectId, file, doc, 'open');
  return true;
}

export function changeDocWithSession(
  projectId: number,
  file: string,
  version: number,
  changes: DocChange[],
  syncSessionId: string,
): DocChangeResult {
  const doc = docs.get(key(projectId, file));
  if (!doc) {
    const latest = latestSessions.get(key(projectId, file));
    if (latest && sessionIsOlder(syncSessionId, latest)) {
      counters.staleSessionIgnored += 1;
      return 'stale-session';
    }
    counters.resync += 1;
    return 'resync';
  }
  if ((doc.syncSessionId ?? 'legacy') !== syncSessionId) {
    counters.staleSessionIgnored += 1;
    return 'stale-session';
  }
  // Monaco versions are strictly increasing per model. Equal or older means
  // a duplicate/out-of-order delivery; a gap means we missed a frame. Both
  // are unrecoverable without the full text.
  if (version <= doc.version) { counters.resync += 1; return 'resync'; }
  let content = doc.content;
  for (const c of changes) {
    if (c.rangeOffset < 0 || c.rangeOffset + c.rangeLength > content.length) {
      counters.resync += 1;
      return 'resync';
    }
    content = content.slice(0, c.rangeOffset) + c.text + content.slice(c.rangeOffset + c.rangeLength);
  }
  doc.content = content;
  doc.version = version;
  emit(projectId, file, doc, 'change', changes);
  return 'ok';
}

/** Legacy/test facade: false means the caller must full-resync. */
export function changeDoc(projectId: number, file: string, version: number, changes: DocChange[]): boolean {
  return changeDocWithSession(projectId, file, version, changes, docs.get(key(projectId, file))?.syncSessionId ?? 'legacy') === 'ok';
}

export function closeDoc(projectId: number, file: string, syncSessionId?: string): boolean {
  const k = key(projectId, file);
  const doc = docs.get(k);
  if (!doc) return false;
  if (syncSessionId !== undefined && (doc.syncSessionId ?? 'legacy') !== syncSessionId) {
    counters.staleSessionIgnored += 1;
    return false;
  }
  docs.delete(k);
  emit(projectId, file, doc, 'close');
  return true;
}

/** Close every live buffer owned by a project and forward didClose events. */
export function closeProjectDocs(projectId: number): number {
  const files = docsForProject(projectId).map(({ file }) => file);
  for (const file of files) closeDoc(projectId, file);
  for (const k of latestSessions.keys()) {
    if (k.startsWith(`${projectId}:`)) latestSessions.delete(k);
  }
  return files.length;
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

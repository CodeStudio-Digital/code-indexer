import { sessionJournalPath } from '../session-journal-path.js';
import type {
  CatalogEntry,
  ProjectId,
} from '@mcp/session-storage';
import type { FsSessionStore } from './fs-session-store.js';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const EXPLICIT_MEMORY_TOOLS = new Set([
  'recall_memory',
  'remember',
  'forget_memory',
  'search_memory',
  'save_memory',
]);

export interface FsSessionMemoryKpis {
  windowDays: number;
  sessionsInWindow: number;
  learnedSessions: number;
  explicitCalls: Record<string, number>;
}

type MemoryKpiSessionStore = Pick<
  FsSessionStore,
  | 'ensureCatalog'
  | 'catalog'
  | 'listSessionEvents'
  | 'listSessionToolCalls'
> & Partial<Pick<FsSessionStore, 'listSessionMemoryToolCalls'>>;

interface BundleSignals {
  learned: Array<{ at: number; projectId: number | null }>;
  calls: Array<{ at: number; name: string }>;
  incomplete?: boolean;
}
interface KpiCache {
  bundles: Map<string, { signature: string; signals: Promise<BundleSignals> }>;
  requests: Map<string, { expires: number; result: Promise<FsSessionMemoryKpis> }>;
}
const caches = new WeakMap<object, KpiCache>();

async function bundleSignature(entry: CatalogEntry): Promise<string> {
  const paths = [join(entry.location.bundle_path, 'events'), sessionJournalPath(entry.location.bundle_path)];
  const signatures = await Promise.all(paths.map(async path => {
    try { const info = await stat(path); return `${info.dev}:${info.ino}:${info.birthtimeMs}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`; }
    catch { return 'unavailable'; }
  }));
  return `${entry.session.updated_at}:${signatures.join('|')}`;
}

async function readSignals(sessions: MemoryKpiSessionStore, entry: CatalogEntry): Promise<BundleSignals> {
  const [eventsResult, callsResult] = await Promise.allSettled([
    sessions.listSessionEvents(entry.session.id, 'memory_distill'),
    sessions.listSessionMemoryToolCalls
      ? sessions.listSessionMemoryToolCalls(entry.session.id)
      : sessions.listSessionToolCalls(entry.session.id).then(calls => calls.map(call => ({ tool_name: call.tool_name, created_at: call.output.created_at }))),
  ]);
  const events = eventsResult.status === 'fulfilled' ? eventsResult.value : [];
  const calls = callsResult.status === 'fulfilled' ? callsResult.value : [];
  return {
    incomplete: eventsResult.status === 'rejected' || callsResult.status === 'rejected',
    learned: events.filter(event => {
      const payload = objectRecord(event.payload);
      return nonNegativeNumber(payload.created) + nonNegativeNumber(payload.merged) > 0;
    }).map(event => ({ at: Date.parse(event.created_at), projectId: payloadProjectId(event.payload) })),
    calls: calls.flatMap(call => {
      const name = call.tool_name.replace(/^mcp__/, '');
      return EXPLICIT_MEMORY_TOOLS.has(name) ? [{ at: Date.parse(call.created_at), name }] : [];
    }),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function payloadProjectId(value: unknown): number | null {
  const payload = objectRecord(value);
  const candidate = payload.projectId ?? payload.project_id;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate)
    ? candidate
    : null;
}

export function sessionEntryIncludesProject(
  entry: CatalogEntry,
  projectId: ProjectId,
): boolean {
  return (
    entry.session.owner_project_id === projectId ||
    entry.session.linked_projects.some(
      (project) => project.project_id === projectId,
    )
  );
}

/**
 * Derives the session-owned half of Agent Memory KPIs from bundle journals.
 * Reads are intentionally bounded to one bundle at a time; no global index or
 * SQLite compatibility query is created.
 */
export async function readFsSessionMemoryKpis(
  sessions: MemoryKpiSessionStore,
  projectId: ProjectId,
  options: {
    windowDays?: number;
    now?: number;
  } = {},
): Promise<FsSessionMemoryKpis> {
  let cache = caches.get(sessions);
  if (!cache) { cache = { bundles: new Map(), requests: new Map() }; caches.set(sessions, cache); }
  const key = `${projectId}:${options.windowDays ?? 30}:${options.now ?? 'live'}`;
  const previous = cache.requests.get(key);
  if (previous && previous.expires > Date.now()) return previous.result;
  // Coalesce polling clients; unchanged bundles retain compact signals, never transcripts.
  const result = readUncached(sessions, projectId, options, cache);
  const request = { expires: Number.POSITIVE_INFINITY, result };
  cache.requests.set(key, request);
  try { const value = await result; request.expires = Date.now() + 5_000; return value; }
  catch (error) { cache.requests.delete(key); throw error; }
}

async function readUncached(
  sessions: MemoryKpiSessionStore,
  projectId: ProjectId,
  options: { windowDays?: number; now?: number },
  cache: KpiCache,
): Promise<FsSessionMemoryKpis> {
  const windowDays = Math.max(
    1,
    Math.floor(options.windowDays ?? 30),
  );
  const now = options.now ?? Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1_000;
  await sessions.ensureCatalog();
  const relevant = sessions.catalog
    .list()
    .filter((entry) => sessionEntryIncludesProject(entry, projectId));
  const catalogPaths = new Set(sessions.catalog.list().map(entry => entry.location.bundle_path));
  for (const path of cache.bundles.keys()) if (!catalogPaths.has(path)) cache.bundles.delete(path);
  for (const [key, value] of cache.requests) if (value.expires < Date.now()) cache.requests.delete(key);

  let sessionsInWindow = 0;
  const learned = new Set<string>();
  const explicitCalls: Record<string, number> = {};

  for (const entry of relevant) {
    const createdAt = Date.parse(entry.session.created_at);
    const createdInWindow =
      Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now;
    if (createdInWindow) sessionsInWindow += 1;

    try {
      const path = entry.location.bundle_path;
      const signature = await bundleSignature(entry);
      let cached = cache.bundles.get(path);
      if (!cached || cached.signature !== signature) {
        cached = { signature, signals: readSignals(sessions, entry) };
        cache.bundles.set(path, cached);
      }
      let signals: BundleSignals;
      try { signals = await cached.signals; }
      catch (error) { cache.bundles.delete(path); throw error; }
      if (signals.incomplete) cache.bundles.delete(path);
      if (createdInWindow && signals.learned.some(event =>
        event.at >= cutoff && event.at <= now && event.projectId === projectId)) {
        learned.add(String(entry.session.id));
      }
      for (const call of signals.calls) {
        if (!(call.at >= cutoff && call.at <= now)) continue;
        explicitCalls[call.name] = (explicitCalls[call.name] ?? 0) + 1;
      }
    } catch {
      // Keep the KPI endpoint best-effort per bundle.
    }
  }

  return {
    windowDays,
    sessionsInWindow,
    learnedSessions: learned.size,
    explicitCalls,
  };
}

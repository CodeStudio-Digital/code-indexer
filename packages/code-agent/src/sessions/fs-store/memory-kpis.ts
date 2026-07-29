import type {
  CatalogEntry,
  ProjectId,
} from '@mcp/session-storage';
import type { FsSessionStore } from './fs-session-store.js';

const EXPLICIT_MEMORY_TOOLS = new Set([
  'recall_memory',
  'remember',
  'forget_memory',
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
>;

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

  let sessionsInWindow = 0;
  const learned = new Set<string>();
  const explicitCalls: Record<string, number> = {};

  for (const entry of relevant) {
    const createdAt = Date.parse(entry.session.created_at);
    const createdInWindow =
      Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now;
    if (createdInWindow) sessionsInWindow += 1;

    try {
      const events = await sessions.listSessionEvents(
        entry.session.id,
        'memory_distill',
      );
      if (
        createdInWindow &&
        events.some((event) => {
          const created = Date.parse(event.created_at);
          if (
            !Number.isFinite(created) ||
            created < cutoff ||
            created > now ||
            payloadProjectId(event.payload) !== projectId
          ) {
            return false;
          }
          const payload = objectRecord(event.payload);
          return (
            nonNegativeNumber(payload.created) +
            nonNegativeNumber(payload.merged)
          ) > 0;
        })
      ) {
        learned.add(String(entry.session.id));
      }
    } catch {
      // One unreadable bundle must not hide the remaining project metrics.
    }

    try {
      for (const call of await sessions.listSessionToolCalls(
        entry.session.id,
      )) {
        if (!EXPLICIT_MEMORY_TOOLS.has(call.tool_name)) continue;
        const created = Date.parse(call.output.created_at);
        if (
          !Number.isFinite(created) ||
          created < cutoff ||
          created > now
        ) {
          continue;
        }
        explicitCalls[call.tool_name] =
          (explicitCalls[call.tool_name] ?? 0) + 1;
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

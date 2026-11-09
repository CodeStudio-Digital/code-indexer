import type { CodeIndexDB } from '@mcp/store/db.js';

/** Record content that reached a prompt/tool response, never search candidates. */
export function recordMemoryAccess(
  db: CodeIndexDB,
  ids: readonly (number | string)[],
  eventType: 'injected' | 'explicit_read',
): void {
  const numbers = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
  if (!numbers.length) return;
  try {
    const write = () => {
      const rows = db.getAgentMemoriesByIds(numbers).filter(row => !row.archived_at);
      if (!rows.length) return;
      db.bumpAgentMemoryAccess(rows.map(row => row.id));
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = `${row.scope}:${row.project_id}`;
        const group = groups.get(key) ?? [];
        group.push(row); groups.set(key, group);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        db.recordAgentMemoryEvent({ eventType, scope: first.scope, projectId: first.project_id,
          kept: group.length, meta: { memoryIds: group.map(row => row.id) } });
      }
    };
    if (typeof db.withBusyTimeout === 'function') db.withBusyTimeout(0, write);
    else write();
  } catch { /* Telemetry cannot delay or fail a run. */ }
}

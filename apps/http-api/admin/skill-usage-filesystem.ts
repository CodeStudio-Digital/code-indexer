import type { JsonValue } from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';

export interface FilesystemSkillUsageStats {
  total_invocations: number;
  last_used: string | null;
  success_rate: number | null;
  top_error_codes: Array<{ code: string; count: number }>;
}

function objectPayload(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

/**
 * Rebuild global skill health from immutable per-session events.
 *
 * There is intentionally no persisted cross-session index. The catalog is an
 * in-memory projection over known bundle roots and each event is read from its
 * owning bundle.
 */
export async function readFilesystemSkillUsageStats(
  sessions: FsSessionStore,
  skillId: string,
): Promise<FilesystemSkillUsageStats> {
  await sessions.ensureCatalog();
  let total = 0;
  let knownOutcomes = 0;
  let successes = 0;
  let lastUsed: string | null = null;
  const errors = new Map<string, number>();

  for (const entry of sessions.catalog.list()) {
    let events;
    try {
      const [dotEvents, underscoreEvents] = await Promise.all([
        sessions.listSessionEvents(entry.session.id, 'skill.usage'),
        sessions.listSessionEvents(entry.session.id, 'skill_usage'),
      ]);
      events = [...dotEvents, ...underscoreEvents];
    } catch {
      // A non-coder operational bundle may use a different event repository.
      continue;
    }
    for (const event of events) {
      const payload = objectPayload(event.payload);
      if (payload?.skill_id !== skillId) continue;
      total += 1;
      if (lastUsed == null || event.created_at > lastUsed) {
        lastUsed = event.created_at;
      }
      if (
        payload.outcome === 'success'
        || payload.outcome === 'failed'
        || payload.outcome === 'aborted'
      ) {
        knownOutcomes += 1;
        if (payload.outcome === 'success') successes += 1;
      }
      if (typeof payload.error_code === 'string' && payload.error_code) {
        errors.set(payload.error_code, (errors.get(payload.error_code) ?? 0) + 1);
      }
    }
  }

  return {
    total_invocations: total,
    last_used: lastUsed,
    success_rate: knownOutcomes > 0 ? successes / knownOutcomes : null,
    top_error_codes: [...errors]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) =>
        right.count - left.count || left.code.localeCompare(right.code),
      )
      .slice(0, 5),
  };
}

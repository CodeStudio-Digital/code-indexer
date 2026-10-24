import { randomUUID } from 'node:crypto';
import { toJsonValue } from './conversation-codec.js';
import type { FsSessionStore } from './fs-session-store.js';

/** Storage needs only the owner identity. Producers retain their own event
 * schema; the full event is serialized without importing a pipeline engine. */
interface SessionScopedDiagnostic {
  readonly sessionId?: string;
  readonly companySessionId?: string;
}

/**
 * Routes only session-scoped candidate-pipeline diagnostics to immutable
 * files in the owning bundle. Global events remain intentionally unpersisted:
 * there is no session catalog or telemetry hot path in SQLite after the cut.
 */
export class FsPipelineTelemetrySink {
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly sessions: FsSessionStore) {}

  emit<Event extends SessionScopedDiagnostic>(event: Event): void {
    const targetSessionId = event.sessionId ?? event.companySessionId;
    if (!targetSessionId) return;

    let task: Promise<void>;
    task = this.#persist(targetSessionId, event)
      .catch((error) => {
        // Observability must not fail a real pipeline execution. This is still
        // fail-closed with respect to storage: no central fallback is used.
        console.warn(
          `[pipeline-telemetry] filesystem write failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  async #persist(
    targetSessionId: string,
    event: SessionScopedDiagnostic,
  ): Promise<void> {
    const location = await this.sessions.getSessionLocation(targetSessionId);
    if (!location) {
      throw new Error(`unknown filesystem session ${targetSessionId}`);
    }
    const id = randomUUID();
    await this.sessions.repository.writeEntity(
      location,
      'metrics/pipeline_stages',
      id,
      toJsonValue({
        schema_version: 1,
        metric_kind: 'pipeline_stage',
        id,
        recorded_at: new Date().toISOString(),
        target_session_id: targetSessionId,
        ...event,
      }),
    );
  }
}

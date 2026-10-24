import { type SemanticJobRow, type SemanticPurpose } from '@mcp/store/semantic-store.js';
import { isPurpose } from './semantic-target-validation.js';
import { type SemanticAdminRuntime } from './semantic-admin-types.js';

const REINDEX_NAMESPACE_PREFIX = 'semantic:reindex:';

const REINDEX_LEASE_MS = 30_000;

function reindexPurpose(job: SemanticJobRow): SemanticPurpose | null {
  const fromCursor = job.cursor?.purpose;
  if (fromCursor === 'code' || fromCursor === 'docs' || fromCursor === 'memory') return fromCursor;
  const fromNamespace = job.namespace.slice(REINDEX_NAMESPACE_PREFIX.length);
  return isPurpose(fromNamespace) ? fromNamespace : null;
}

function withoutLease(cursor: Record<string, unknown> | null): Record<string, unknown> {
  const next = { ...(cursor ?? {}) };
  delete next.lease_owner;
  delete next.lease_expires_at_ms;
  return next;
}

function assertReindexSucceeded(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const failed = (result as { failed_namespaces?: unknown }).failed_namespaces;
  if (!Array.isArray(failed) || failed.length === 0) return;
  const details = failed.map((entry) => {
    if (!entry || typeof entry !== 'object') return String(entry);
    const row = entry as { namespace?: unknown; error?: unknown };
    return `${String(row.namespace ?? 'unknown')}: ${String(row.error ?? 'failed')}`;
  });
  throw new Error(`reindex paused with ${failed.length} failed namespace(s): ${details.join('; ')}`);
}

/** Small durable consumer for control-plane reindex requests. The heavy build
 * starts only after the HTTP handler has returned its 202 response. */
export class SemanticReindexDispatcher {
  private draining: Promise<void> | null = null;
  private readonly requestedPurposes = new Set<SemanticPurpose>();
  private readonly workerId = `semantic-admin:${process.pid}:${Math.random().toString(16).slice(2)}`;

  constructor(private readonly runtime: SemanticAdminRuntime) {
    // Normalize expired leases for visibility, but never resume them merely
    // because the application started. Only enqueue() is an execution wake-up.
    this.runtime.store.recoverExpiredReindexJobs();
  }

  enqueue(purpose: SemanticPurpose): SemanticJobRow {
    const job = this.runtime.store.enqueueReindexJob(purpose);
    this.requestedPurposes.add(purpose);
    this.kick();
    return job;
  }

  private kick(): void {
    if (this.draining) return;
    queueMicrotask(() => {
      if (this.draining) return;
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (this.requestedPurposes.size > 0) this.kick();
      });
    });
  }

  private async drain(): Promise<void> {
    while (this.requestedPurposes.size > 0) {
      const purposeToRun = this.requestedPurposes.values().next().value as SemanticPurpose;
      this.requestedPurposes.delete(purposeToRun);
      // A click wakes only the purpose the operator confirmed. A pending job
      // intentionally preserved across restart must not be started as a side
      // effect of confirming the other profile.
      const job = this.runtime.store.claimNextReindexJob(
        this.workerId,
        REINDEX_LEASE_MS,
        Date.now(),
        purposeToRun,
      );
      if (!job) continue;
      const purpose = reindexPurpose(job);
      if (!purpose) {
        this.runtime.store.updateJob(job.id, {
          status: 'failed',
          cursor: withoutLease(job.cursor),
          failed_items: Math.max(1, job.failed_items),
          error: `invalid reindex job namespace: ${job.namespace}`,
        });
        continue;
      }

      const heartbeat = setInterval(() => {
        this.runtime.store.renewReindexJobLease(job.id, this.workerId, REINDEX_LEASE_MS);
      }, Math.max(1_000, Math.floor(REINDEX_LEASE_MS / 3)));
      heartbeat.unref?.();
      try {
        const result = await this.runtime.reindex(purpose);
        assertReindexSucceeded(result);
        this.runtime.store.updateJob(job.id, {
          status: 'completed',
          cursor: { ...withoutLease(job.cursor), result },
          processed_items: 1,
          error: null,
        });
      } catch (error) {
        // Provider/model failures are resumable. A later POST changes this
        // paused row back to pending without losing its attempt history.
        this.runtime.store.updateJob(job.id, {
          status: 'paused',
          cursor: withoutLease(job.cursor),
          failed_items: job.failed_items + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}

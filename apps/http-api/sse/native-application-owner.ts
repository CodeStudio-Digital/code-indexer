import type { FileControlPlaneAuthority } from '../file-control-plane-store.js';
import type { WorkerPreviewOwner } from './worker-preview-calls.js';

export type WorkerApplicationOwnerResolver = (runId: unknown, closing?: boolean,
  agentRunId?: string) => WorkerPreviewOwner | Promise<WorkerPreviewOwner>;

/** A worker can serve many root runs, but each tree has at most 256 members.
 * Call only after checking the main-owned worker run. Closed siblings stay
 * fenced until that entire run is replaced. */
export class NativeAttemptDrainFence {
  private runId: unknown;
  private readonly attempts = new Set<string>();
  private select(runId: unknown) {
    if (runId !== this.runId) { this.attempts.clear(); this.runId = runId; }
  }
  assertOpen(runId: unknown, attemptId: string): void {
    this.select(runId);
    if (this.attempts.has(attemptId)) throw new Error('Native application attempt is draining');
  }
  begin(runId: unknown, attemptId: string): void {
    this.select(runId);
    if (!this.attempts.has(attemptId) && this.attempts.size >= 256) throw new Error('Native application drain budget exhausted');
    this.attempts.add(attemptId);
  }
}

/** A selector is only an address. Main resolves it against the root's durable
 * admission receipt; the caller never supplies a trusted child context. */
export function nativeApplicationTarget(request: unknown): string | undefined {
  const packet = request as { agentRunId?: unknown; authority?: { payload?: { lease?: { ownerAgentRunId?: unknown } } } } | undefined;
  const explicit = packet?.agentRunId, bound = packet?.authority?.payload?.lease?.ownerAgentRunId;
  for (const id of [explicit, bound]) {
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) throw new Error('Invalid native application owner selector');
  }
  if (explicit !== undefined && bound !== undefined && explicit !== bound) throw new Error('Native application owner differs from its bound lease');
  return (explicit ?? bound) as string | undefined;
}

export async function resolveNativeApplicationOwner(owner: WorkerPreviewOwner,
  store: Pick<FileControlPlaneAuthority, 'resolveNativeChild'> | null | undefined,
  agentRunId?: string, closing = false): Promise<WorkerPreviewOwner> {
  owner.assertOwner();
  if (agentRunId === undefined || agentRunId === owner.config?.context.agentRunId) return owner;
  if (!owner.config || !store) throw new Error('Application child routing requires a native root');
  const context = await store.resolveNativeChild(owner.config.context, agentRunId, !closing);
  owner.assertOwner();
  return { ...owner, config: { ...owner.config, context } };
}

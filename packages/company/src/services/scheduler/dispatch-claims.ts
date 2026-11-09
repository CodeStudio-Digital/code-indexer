import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';

export interface DispatchClaim {
  token: string;
  epoch: number;
  sessionId: string;
  agentRunId: string;
  phase: 'reserved' | 'starting' | 'running' | 'released' | 'uncertain' | 'reviewing';
  leaseUntil: number;
  createdAt?: number;
  manualDispatchRequired?: boolean;
  error?: string;
  review?: { startedAt: number; completedAt?: number; previousPhase: string; originalOutcome: 'unchanged' };
}

/** Company-wide ownership, shared by every worker and manual dispatch. Immutable
 * revision publication provides cross-process CAS, not an in-memory mutex.
 * Only a reservation with NO possible spawn may expire. Starting/uncertain
 * claims require reconciliation; time passing is never proof of no effects. */
export class DispatchClaims {
  private readonly files: CollaborationFiles;
  private readonly revisions: CollaborationRevisions;
  constructor(bundlePath: string, private readonly now = Date.now) {
    this.files = new CollaborationFiles(join(bundlePath, 'company', 'dispatch-coordination'));
    this.revisions = new CollaborationRevisions(this.files);
  }
  async read(cardId: string): Promise<DispatchClaim | null> {
    return (await this.revisions.read<DispatchClaim>('claims', cardId))?.value ?? null;
  }
  async acquire(cardId: string, sessionId: string, options?: { manual?: boolean }): Promise<DispatchClaim | null> {
    await this.files.ensure('claims');
    const token = randomUUID();
    const initial: DispatchClaim = { token: '', epoch: 0, sessionId, agentRunId: '', phase: 'released', leaseUntil: 0 };
    try {
      const result = await this.revisions.change<DispatchClaim>('claims', cardId, initial, (previous): DispatchClaim => {
        if (previous.manualDispatchRequired && !options?.manual) throw new Error('dispatch_owned');
        if (previous.phase !== 'released' && !(previous.phase === 'reserved' && previous.leaseUntil <= this.now())) {
          throw new Error('dispatch_owned');
        }
        return { token, epoch: previous.epoch + 1, sessionId, agentRunId: randomUUID(), phase: 'reserved', leaseUntil: this.now() + 60_000, createdAt: this.now() };
      });
      return result.value;
    } catch (error) {
      if (error instanceof Error && error.message === 'dispatch_owned') return null;
      throw error;
    }
  }
  async transition(cardId: string, claim: DispatchClaim, phase: DispatchClaim['phase'], error?: string): Promise<DispatchClaim> {
    const result = await this.revisions.change('claims', cardId, claim, current => {
      if (current.token !== claim.token || current.epoch !== claim.epoch || current.phase === 'released' || current.phase === 'reviewing') {
        throw new Error('dispatch_fenced');
      }
      if (phase === 'starting' && (current.phase !== 'reserved' || current.leaseUntil <= this.now())) throw new Error('dispatch_fenced');
      return { ...current, phase, ...(error ? { error } : {}) };
    });
    return result.value;
  }

  /** Fences the original dispatcher before operator-reviewed bookkeeping. A
   * failed/crashed review remains resumable and cannot enable an automatic run. */
  async beginReview(cardId: string, token: string, epoch: number): Promise<DispatchClaim> {
    const observed = await this.read(cardId);
    if (!observed) throw new Error('DISPATCH_REVIEW_STALE');
    const result = await this.revisions.change('claims', cardId, observed, current => {
      if (current.token !== token || current.epoch !== epoch || current.phase === 'released') throw new Error('DISPATCH_REVIEW_STALE');
      return { ...current, phase: 'reviewing' as const, review: current.review ?? { startedAt: this.now(), previousPhase: current.phase, originalOutcome: 'unchanged' as const } };
    });
    return result.value;
  }

  async completeReview(cardId: string, token: string, epoch: number): Promise<DispatchClaim> {
    const observed = await this.read(cardId);
    if (!observed) throw new Error('DISPATCH_REVIEW_STALE');
    const result = await this.revisions.change('claims', cardId, observed, current => {
      if (current.token !== token || current.epoch !== epoch || current.phase !== 'reviewing' || !current.review) throw new Error('DISPATCH_REVIEW_STALE');
      return { ...current, phase: 'released' as const, manualDispatchRequired: true, review: { ...current.review, completedAt: this.now() } };
    });
    return result.value;
  }
}

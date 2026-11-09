import type { TaskProposal, ScheduledTrigger, ScheduledOccurrence } from '@mcp/agent-runtime-contracts';
import { keyOf, type CollaborationFiles } from './files.js';
import { CollaborationRevisions, type Revision } from './revisions.js';

type Followup = TaskProposal | ScheduledTrigger | ScheduledOccurrence;
type Kind = 'proposals' | 'schedules' | 'occurrences';

/** Versioned domain records share the mailbox's immutable publication protocol. */
export class CollaborationFollowups {
  readonly revisions: CollaborationRevisions;
  constructor(readonly files: CollaborationFiles) { this.revisions = new CollaborationRevisions(files); }
  async get<T extends Followup>(kind: Kind, id: string): Promise<T | null> {
    return (await this.revisions.read<T>(kind, id))?.value ?? null;
  }
  async list<T extends Followup>(kind: Kind, sessionId?: string): Promise<T[]> {
    const latest = new Map<string, Revision<T>>();
    for (const row of await this.files.list<Revision<T>>(kind)) {
      if (row.schemaVersion !== 1 || !row.value?.id) throw new Error('corrupt_followup_record');
      if ((!sessionId || row.value.sessionId === sessionId) && row.revision > (latest.get(row.value.id)?.revision ?? 0)) latest.set(row.value.id, row);
    }
    return [...latest.values()].map(row => row.value);
  }
  async change<T extends Followup>(kind: Kind, value: T, update: (value: T) => T, expectedRevision?: number): Promise<T> {
    const result = await this.revisions.change(kind, value.id, value, current => {
      const next = update(current);
      if ('revision' in next) next.revision = ('revision' in current ? current.revision : 0) + 1;
      return next;
    }, expectedRevision);
    return result.value;
  }
  async propose(input: Pick<TaskProposal, 'sessionId' | 'title' | 'prompt' | 'rationale' | 'sourceRevision' | 'context'>,
    key: string, now = Date.now()): Promise<TaskProposal> {
    if (!key || !input.title?.trim() || input.title.length > 160 || !input.prompt?.trim() || input.prompt.length > 24000
      || input.rationale.length > 2000 || !['fresh', 'workspace', 'fork'].includes(input.context)) throw new Error('invalid_proposal');
    const id = keyOf(`${input.sessionId}:${key}`);
    const previous = await this.get<TaskProposal>('proposals', id);
    if (previous) {
      if (previous.prompt !== input.prompt || previous.context !== input.context || previous.title !== input.title) throw new Error('idempotency_conflict');
      return previous;
    }
    const pending = (await this.list<TaskProposal>('proposals', input.sessionId)).filter(row => row.state === 'pending' && row.expiresAt > now);
    if (pending.length >= 20) throw new Error('proposal_capacity');
    const proposal: TaskProposal = { ...input, schemaVersion: 1, id, revision: 0, state: 'pending', createdAt: now, expiresAt: now + 7 * 86400_000 };
    return this.change('proposals', proposal, row => row, 0);
  }
  async claim(id: string, sessionId: string, mode: 'here' | 'new', key: string, expectedRevision: number, now = Date.now()): Promise<TaskProposal> {
    const row = await this.get<TaskProposal>('proposals', id);
    if (!row || row.sessionId !== sessionId) throw new Error('scope_denied');
    if (!key || !['here', 'new'].includes(mode)) throw new Error('invalid_claim');
    // Stable claim survives the create-session/response crash window.
    if (row.claimKey === key && row.mode === mode) return row;
    return this.change('proposals', row, current => {
      if (current.state !== 'pending' || current.expiresAt <= now) throw new Error('proposal_unavailable');
      return { ...current, state: 'claimed', claimKey: key, mode };
    }, expectedRevision);
  }
  /** Observation of an already admitted human run, never execution authority.
   * Edited/unrelated prompts stay prepared rather than falsely marked started. */
  async observeStarted(sessionId: string, runId: string, prompt: string): Promise<void> {
    for (const row of await this.list<TaskProposal>('proposals')) {
      if (row.state !== 'accepted' || row.targetSessionId !== sessionId || row.prompt.trim() !== prompt.trim()) continue;
      await this.change('proposals', row, current => current.state === 'accepted'
        ? { ...current, state: 'started', startedRunId: runId } : current);
    }
  }
}

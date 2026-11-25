import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';

export interface WorkspaceMutationOwner {
  /** Older records predate the distinction between project writes and Company control calls. */
  scope?: 'workspace';
  token: string;
  sessionId: string;
  agentRunId: string;
  toolUseId: string;
  toolName: string;
  phase: 'running' | 'uncertain';
  startedAt: number;
}
interface WorkspaceState { holders: WorkspaceMutationOwner[] }

// This retired native tool only listened for agent events. Older workers could
// persist its wait as an uncertain writer. Keep the revision as audit evidence.
function projectOwners(holders: WorkspaceMutationOwner[]): WorkspaceMutationOwner[] {
  return holders.filter(owner => owner.scope !== undefined || owner.toolName !== 'wait_for_subordinates');
}

export class WorkspaceOutcomePendingError extends Error {
  constructor(readonly owners: WorkspaceMutationOwner[]) { super('WORKSPACE_OUTCOME_PENDING'); }
}
interface MutationInput {
  sessionId: string; agentRunId: string; toolUseId: string; toolName: string; signal?: AbortSignal;
  onWaiting?: (waiting: boolean) => void;
  pendingEffects?: () => readonly Promise<void>[];
}
export interface WorkspaceMutationGate {
  run<T>(input: MutationInput, effect: () => Promise<T>, unknown: (result: T) => boolean): Promise<T>;
}

/** Serializes mutations between company sessions, without serializing reads or
 * holding locks around orchestration waits. There is no lease timeout that can
 * silently grant a second writer while the first effect is still running. */
export class CompanyWorkspaceCoordinator implements WorkspaceMutationGate {
  private readonly files: CollaborationFiles;
  private readonly revisions: CollaborationRevisions;
  constructor(bundlePath: string) {
    this.files = new CollaborationFiles(join(bundlePath, 'company', 'workspace-coordination'));
    this.revisions = new CollaborationRevisions(this.files);
  }
  async owners(): Promise<WorkspaceMutationOwner[]> {
    return projectOwners((await this.revisions.read<WorkspaceState>('ownership', 'workspace'))?.value.holders ?? []);
  }
  private async change(apply: (value: WorkspaceState) => WorkspaceState): Promise<void> {
    await this.files.ensure('ownership');
    await this.revisions.change<WorkspaceState>('ownership', 'workspace', { holders: [] },
      state => apply({ holders: projectOwners(state.holders) }));
  }
  async run<T>(input: MutationInput, effect: () => Promise<T>, unknown: (result: T) => boolean): Promise<T> {
    await this.files.ensure('ownership');
    const owner: WorkspaceMutationOwner = { scope: 'workspace', sessionId: input.sessionId, agentRunId: input.agentRunId, toolUseId: input.toolUseId, toolName: input.toolName, token: randomUUID(), phase: 'running', startedAt: Date.now() };
    let acquired = false;
    let waiting = false;
    while (!acquired) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Workspace wait cancelled');
      // Watch BEFORE checking ownership: release between check/watch cannot be lost.
      let wake!: () => void;
      const changed = new Promise<void>(resolve => { wake = resolve; });
      const watcher = watch(join(this.files.root, 'ownership'), { persistent: false }, () => wake());
      watcher.on('error', wake);
      input.signal?.addEventListener('abort', wake, { once: true });
      try {
        await this.change(state => {
          const uncertainOwners = state.holders.filter(holder => holder.phase === 'uncertain');
          if (uncertainOwners.length) throw new WorkspaceOutcomePendingError(uncertainOwners);
          if (state.holders.some(holder => holder.sessionId !== input.sessionId)) throw new Error('WORKSPACE_OWNED');
          return { holders: [...state.holders, owner] };
        });
        acquired = true;
        if (waiting) { try { input.onWaiting?.(false); } catch { /* UI observer cannot alter ownership. */ } }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'WORKSPACE_OWNED') throw error;
        if (!waiting) { waiting = true; try { input.onWaiting?.(true); } catch { /* UI observer is optional. */ } }
        await changed;
      } finally {
        watcher.close();
        input.signal?.removeEventListener('abort', wake);
      }
    }
    let uncertain = false;
    let effectStarted = false;
    try {
      // Cancellation during CAS admission must not start an effect.
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Workspace wait cancelled');
      effectStarted = true;
      const result = await effect();
      uncertain = unknown(result);
      return result;
    } catch (error) {
      // If execution began, an exception is not proof that its effects ended.
      uncertain = effectStarted;
      throw error;
    } finally {
      const settle = (pendingUnknown: boolean) => this.change(state => ({ holders: pendingUnknown
        ? state.holders.map(holder => holder.token === owner.token ? { ...holder, phase: 'uncertain' } : holder)
        : state.holders.filter(holder => holder.token !== owner.token) }));
      const pending = input.pendingEffects?.() ?? [];
      if (!uncertain && pending.length) {
        // exec_command can yield while its process continues writing. Retain
        // ownership until the transport's real exit receipt, not handler return.
        void Promise.all(pending).then(() => settle(false), () => settle(true)).catch(error => console.warn('[company workspace] settlement pending:', String(error)));
      } else await settle(uncertain);
    }
  }
  /** Operator reconciliation is explicit and fenced by the exact observed
   * token set. It never converts unknown tool results into success. */
  async reconcile(tokens: readonly string[]): Promise<void> {
    if (!tokens.length) throw new Error('No workspace operations selected');
    await this.change(state => {
      if (tokens.some(token => !state.holders.some(holder => holder.token === token))) throw new Error('WORKSPACE_REVIEW_STALE');
      if (state.holders.some(holder => tokens.includes(holder.token) && holder.phase !== 'uncertain')) throw new Error('WORKSPACE_OWNER_ACTIVE');
      return { holders: state.holders.filter(holder => !tokens.includes(holder.token)) };
    });
  }
  /** Call only after the host has proved the owner worker is absent. Persisted
   * status may be stale after a crash. This classifies uncertainty, never release. */
  async markStoppedOwnersUncertain(tokens: readonly string[]): Promise<void> {
    if (!tokens.length) return;
    await this.change(state => ({ holders: state.holders.map(holder => tokens.includes(holder.token) ? { ...holder, phase: 'uncertain' } : holder) }));
  }
}

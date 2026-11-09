import { createHash } from 'node:crypto';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type { FsToolOutcomeIncident, FsToolOutcomeState } from '@mcp/session-storage/fs-store/tool-outcome-types.js';
import { toJsonValue } from '@mcp/session-storage/fs-store/conversation-codec.js';
import type { OutcomeRecoveryState } from '../core/outcome-recovery-state.js';
import { stableArgsKey } from '../core/runner/dup-utils.js';
import { toolOutcomeInputHash, type ToolOutcomeTerminalReceipt } from '../core/tool-outcome-observer.js';

type Store = Pick<FsSessionStore, 'getToolOutcomeState' | 'resolveToolOutcome' | 'recordToolOutcomeIncident'>;
const hash = (value: unknown): string => createHash('sha256').update(stableArgsKey(value)).digest('hex');
const signature = (name: string, input: unknown): string => hash({ name, input });
const occurrences = (rows: readonly FsToolOutcomeIncident[]): string[] => rows.map(row => row.occurrenceId).sort();
const snapshotKey = (rows: readonly FsToolOutcomeIncident[]): string => hash(rows.map(row => ({ id: row.occurrenceId, tool: row.toolUseId })).sort((a, b) => a.id.localeCompare(b.id)));

/** Runtime-only adapter: only trusted terminal receipts or explicit UI review
 * can resolve an incident. Model prose and ordinary tool text are never read. */
export async function createSessionOutcomeRecovery(options: {
  store: Store;
  sessionId: string;
  initialState?: FsToolOutcomeState;
}) {
  let current = options.initialState ?? await options.store.getToolOutcomeState(options.sessionId);
  let replay = new Map<string, string[]>();
  let unidentifiedPending: string[] = [];
  let serial: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const receipts = new Map<string, { receipt: ToolOutcomeTerminalReceipt; runId: string }>();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = serial.then(task, task);
    serial = next.then(() => undefined, () => undefined);
    return next;
  };
  const update = (state: FsToolOutcomeState): void => {
    current = state;
    replay = new Map();
    unidentifiedPending = state.pending.filter(row => !row.toolName || row.toolName === 'unknown' || row.args == null).map(row => row.toolUseId);
    const reviewed = new Set(state.resolved.filter(row => row.kind === 'user_acknowledged').flatMap(row => [...row.occurrenceIds]));
    const pending = new Set(occurrences(state.pending));
    for (const row of state.incidents) {
      if ((!reviewed.has(row.occurrenceId) && !pending.has(row.occurrenceId)) || !row.toolName || row.args == null) continue;
      const key = signature(row.toolName, row.args);
      const ids = replay.get(key) ?? [];
      if (!ids.includes(row.toolUseId)) ids.push(row.toolUseId);
      replay.set(key, ids);
    }
    for (const listener of listeners) { try { listener(); } catch { /* Observer does not alter durable evidence. */ } }
  };
  update(current);

  const reconcileReceipts = async (): Promise<void> => {
    if (!current.pending.length) return;
    for (const { receipt, runId } of receipts.values()) {
      const pending = current.pending.filter(row => row.toolUseId === receipt.toolUseId);
      if (!pending.length || pending.some(row => row.runId !== runId || row.toolName !== receipt.toolName
        || row.args === null || Array.isArray(row.args) || typeof row.args !== 'object'
        || toolOutcomeInputHash(row.args as Record<string, unknown>) !== receipt.inputHash)) continue;
      const result = await options.store.resolveToolOutcome({
        sessionId: options.sessionId, toolUseId: receipt.toolUseId, expectedOccurrenceIds: occurrences(pending),
        operationId: `outcome:receipt:${hash({ runId, id: receipt.invocationId, occurrences: occurrences(pending) })}`,
        resolution: {
          kind: receipt.outcome === 'not_applied' ? 'verified_not_applied' : 'verified_terminal',
          evidence: { source: 'host_receipt',
            summary: receipt.outcome === 'not_applied'
              ? 'The host observed physical completion with no effect.'
              : 'The host received a known terminal result for the exact invocation. This is not a claim that the whole task succeeded.',
            reference: `${runId}:${receipt.invocationId}:${receipt.inputHash}:${receipt.completedAt}` },
        },
      });
      update(result.state);
      // A live incident can be registered before its transcript turn commits.
      // Keep the bounded exact receipt so that later projection of the same
      // occurrence cannot resurrect an already-observed unknown outcome.
    }
  };

  const state: OutcomeRecoveryState = {
    authoritative: true,
    get toolUseIds() { return current.unresolvedToolUseIds; },
    get resolvedToolUseIds() { return current.resolvedToolUseIds; },
    // Incomplete imported evidence cannot prove that a proposed call is new.
    replayToolUseIds: (name, input) => unidentifiedPending.length
      ? [...new Set([...(replay.get(signature(name, input)) ?? []), ...unidentifiedPending])]
      : replay.get(signature(name, input)) ?? [],
    refresh: () => enqueue(reconcileReceipts),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    registerIncident: input => enqueue(async () => {
      await options.store.recordToolOutcomeIncident({ sessionId: options.sessionId,
        operationId: `outcome:delegated:${hash({ source: input.sourceReference, id: input.toolUseId, runId: input.runId })}`,
        ...input, args: toJsonValue(input.args) });
      update(await options.store.getToolOutcomeState(options.sessionId));
      await reconcileReceipts();
    }),
    snapshot: () => {
      const captured = [...current.pending];
      const fingerprint = snapshotKey(captured);
      const seen = new Set<string>();
      const incidents = captured.filter(row => { if (seen.has(row.toolUseId)) return false; seen.add(row.toolUseId); return true; })
        .map(row => ({ toolUseId: row.toolUseId, toolName: row.toolName,
          argsSummary: JSON.stringify(row.args ?? {}).slice(0, 600) }));
      return {
        fingerprint, incidents,
        ...(captured.length ? { acknowledge: () => enqueue(async () => {
          // Compare the complete displayed set, not only the first incident.
          update(await options.store.getToolOutcomeState(options.sessionId));
          const displayed = new Set(occurrences(captured));
          const resolved = new Set(current.resolved.flatMap(row => [...row.occurrenceIds]));
          if (current.pending.some(row => !displayed.has(row.occurrenceId))
            || captured.some(row => !current.pending.some(pending => pending.occurrenceId === row.occurrenceId) && !resolved.has(row.occurrenceId))) {
            throw new Error('Recovery incidents changed since they were displayed.');
          }
          for (const id of seen) {
            const expected = current.pending.filter(row => row.toolUseId === id);
            if (current.pending.some(row => !displayed.has(row.occurrenceId))) {
              throw new Error('Recovery incidents changed while the review was committed.');
            }
            if (!expected.length) continue; // A terminal receipt won the race.
            const result = await options.store.resolveToolOutcome({
              sessionId: options.sessionId, toolUseId: id, expectedOccurrenceIds: occurrences(expected),
              operationId: `outcome:review:${hash({ fingerprint, id })}`,
              resolution: { kind: 'user_acknowledged', evidence: { source: 'user_review',
                summary: 'The user explicitly reviewed the displayed effects/processes and authorized resuming the selected mode. The original outcome remains unconfirmed.',
                reference: fingerprint } },
            });
            update(result.state);
          }
        }) } : {}),
      };
    },
  };

  return {
    state,
    /** Normal calls create no journal writes or history scans. */
    observe(receipt: ToolOutcomeTerminalReceipt, runId: string | undefined): Promise<void> {
      if (!runId || receipt.version !== 1 || !receipt.toolUseId || !/^[a-f0-9]{64}$/.test(receipt.inputHash)) return Promise.resolve();
      receipts.set(receipt.invocationId, { receipt, runId });
      // Bounded metadata only. Eviction loses automatic recovery, never proof.
      while (receipts.size > 1024) receipts.delete(receipts.keys().next().value!);
      return current.unresolvedToolUseIds.includes(receipt.toolUseId) ? enqueue(reconcileReceipts) : Promise.resolve();
    },
    /** Called only after a turn containing a new unknown result is durable. */
    historyCommitted(): Promise<void> {
      return enqueue(async () => {
        update(await options.store.getToolOutcomeState(options.sessionId));
        await reconcileReceipts();
      });
    },
    drain: () => serial,
  };
}

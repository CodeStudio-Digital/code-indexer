import type { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

/** Release only reservations whose matching durable AgentRun has a confirmed
 * terminal receipt. Missing/expired owners remain uncertain, never free credit. */
export async function reconcileUltraBudget(ledger: CollaborationBudget, sessions: FsSessionStore): Promise<void> {
  const state = await ledger.state();
  const bySession = new Map<string, Awaited<ReturnType<FsSessionStore['listSubagentRuns']>>>();
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.kind !== 'agent' || reservation.state === 'settled' || !reservation.runId) continue;
    const receipt = await ledger.files.get<{ runId: string; confirmed: boolean }>('checkpoints', `budget-receipt:${ledger.rootId}:${reservation.id}`);
    if (receipt?.runId === reservation.runId && receipt.confirmed) { await ledger.settle(reservation.id, 0, 0); continue; }
    let page = bySession.get(reservation.owner);
    if (!page) {
      try { page = await sessions.listSubagentRuns(reservation.owner, 0, 1000); bySession.set(reservation.owner, page); }
      catch { continue; }
    }
    const row = page.items.find(row => row.run_id === reservation.runId);
    if (row?.status === 'completed' && !/outcome[_ ]unknown/i.test(row.reason ?? '')) await ledger.settle(reservation.id, 0, 0);
  }
}

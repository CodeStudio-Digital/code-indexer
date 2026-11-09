import { randomUUID } from 'node:crypto';
import type { CollaborationFiles } from './files.js';

interface WaitEdge { participant: string; target?: string; targets?: string[]; mode?: 'any' | 'all'; until: number }

/** Unique waiter ownership prevents concurrent waits from deleting each other.
 * Legacy single-target rows remain readable during rolling migration. */
export async function registerWait(files: CollaborationFiles, participant: string, targets: string[], mode: 'any' | 'all', until: number) {
  const id = randomUUID();
  await files.put('waits', id, { participant, targets, mode, until } satisfies WaitEdge);
  return {
    dispose: () => files.remove('waits', id),
    async cyclic(): Promise<boolean> {
      const rows = (await files.list<WaitEdge>('waits')).filter(row => row.until > Date.now());
      const blocked = (actor: string, visiting: Set<string>): boolean => {
        if (visiting.has(actor)) return true;
        const next = new Set(visiting).add(actor);
        return rows.filter(row => row.participant === actor).some(row => {
          const peers = row.targets ?? (row.target ? [row.target] : []);
          const checks = peers.map(peer => blocked(peer, next));
          // ANY can still finish through a peer outside the cycle; ALL cannot.
          return checks.length > 0 && (row.mode === 'any' ? checks.every(Boolean) : checks.some(Boolean));
        });
      };
      return blocked(participant, new Set());
    },
  };
}

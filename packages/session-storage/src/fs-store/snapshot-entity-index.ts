import { lstat } from 'node:fs/promises';
import type { FsEntityEnvelope } from './entity-files.js';

interface SnapshotNames {
  byKind: Map<string, string[]>;
  byRound: Map<number, string[]>;
}

function append<K>(map: Map<K, string[]>, key: K, name: string): void {
  const names = map.get(key);
  if (names) names.push(name);
  else map.set(key, [name]);
}

/** Projected files are published by atomic rename. Index only their names;
 * selected envelopes and ownership are revalidated on every read. */
export class SnapshotEntityIndex {
  private readonly sessions = new Map<string, { stamp: string; names: Promise<SnapshotNames> }>();

  invalidate(root: string): void { this.sessions.delete(root); }

  async select(root: string, kind: string, round: number | undefined,
    scan: (visit: (name: string, record: FsEntityEnvelope) => void) => Promise<void>): Promise<string[]> {
    const stat = await lstat(root, { bigint: true });
    const stamp = [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].join('/');
    let entry = this.sessions.get(root);
    if (!entry || entry.stamp !== stamp) {
      const byKind = new Map<string, string[]>();
      const byRound = new Map<number, string[]>();
      const names = scan((name, record) => {
        if (name.toLowerCase() !== record.id.toLowerCase() + '.json') throw new Error('Snapshot entity id does not match its filename');
        append(byKind, record.kind, name);
        if (record.kind !== 'round_snapshot') return;
        const data = record.data;
        const seq = data && typeof data === 'object' && 'round_message_seq' in data ? data.round_message_seq : undefined;
        // Unclassified rows still go through the repository's schema validator.
        append(byRound, typeof seq === 'number' ? seq : NaN, name);
      }).then(() => ({ byKind, byRound }));
      entry = { stamp, names };
      void names.catch(() => { if (this.sessions.get(root)?.names === names) this.invalidate(root); });
    }
    this.sessions.delete(root);
    this.sessions.set(root, entry);
    if (this.sessions.size > 16) this.sessions.delete(this.sessions.keys().next().value!);
    const names = await entry.names;
    if (round === undefined) return names.byKind.get(kind) ?? [];
    return (names.byRound.get(round) ?? []).concat(names.byRound.get(NaN) ?? []);
  }
}

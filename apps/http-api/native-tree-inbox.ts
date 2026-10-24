import type { ControlPlaneFileRepository } from '@mcp/session-storage';
import { hashControlPlanePayload, type ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import { runtimeRequestId } from './runtime-attempt-ledger.js';

export interface NativeTreeInboxEntry {
  id: string; from: string; to: string; kind: 'message' | 'followup' | 'input'; message: string;
}
export type NativeInboxSource = { reference: string } | { agentRunId: string; attemptId: string };

export function validateNativeInbox(entries: readonly NativeTreeInboxEntry[]): NativeTreeInboxEntry[] {
  const selected = new Map<string, NativeTreeInboxEntry>();
  for (const entry of entries) {
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.id) || !['message', 'followup', 'input'].includes(entry.kind)
      || typeof entry.message !== 'string' || !entry.message.trim() || Buffer.byteLength(entry.message) > 4096
      || ![entry.from, entry.to].every(path => typeof path === 'string' && path.startsWith('/root') && path.length <= 4096)) {
      throw new Error('Invalid durable native inbox entry');
    }
    const previous = selected.get(entry.id);
    if (previous && hashControlPlanePayload(previous) !== hashControlPlanePayload(entry)) throw new Error('Durable native inbox id diverged');
    selected.set(entry.id, { id: entry.id, from: entry.from, to: entry.to, kind: entry.kind, message: entry.message });
  }
  const result = [...selected.values()];
  if (result.length > 64 || Buffer.byteLength(JSON.stringify(result)) > 24 * 1024) throw new Error('Durable native inbox exceeds bounds');
  return result;
}

/** Caller holds session authority and has resolved this terminal source. */
export async function readNativeInbox(repository: ControlPlaneFileRepository, source: ControlPlaneRunContext): Promise<NativeTreeInboxEntry[]> {
  const inbox: NativeTreeInboxEntry[] = [];
  let cursor: string | undefined, scanned = 0;
  do {
    const page = await repository.list('runtimeRequest', { relation: { name: 'attempt', id: source.attemptId }, cursor, limit: 128, order: 'asc' });
    scanned += page.items.length;
    if (scanned > 65_536) throw new Error('Native inbox recovery scan exceeds bounds');
    for (const row of page.items) {
      const data = row.data;
      if (typeof data.key !== 'string' || !data.key.startsWith('native-tree:inbox:')) continue;
      const payload = data.nativeTree as { schema?: number; type?: string; envelope?: NativeTreeInboxEntry } | undefined;
      if (data.checkpointType !== 'runtime-request-v1' || data.ownerId !== source.executorOwnerId || data.fencingEpoch !== source.fencingEpoch
        || row.id !== runtimeRequestId(source.attemptId, data.key) || row.relations.attempt !== source.attemptId
        || row.relations.session !== source.sessionId || row.relations.run !== source.agentRunId || row.relations.command !== source.commandId
        || payload?.schema !== 1 || payload.type !== 'inbox' || !payload.envelope
        || data.key !== `native-tree:inbox:${payload.envelope.id}` || hashControlPlanePayload(payload) !== data.payloadHash) {
        throw new Error('Durable native inbox authority or payload differs');
      }
      inbox.push(payload.envelope);
    }
    if (page.nextCursor && (page.nextCursor === cursor || !page.items.length)) throw new Error('Native inbox recovery cursor stalled');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return validateNativeInbox(inbox);
}

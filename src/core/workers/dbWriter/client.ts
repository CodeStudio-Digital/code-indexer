import { createPool, resolveWorkerUrl, type Pool } from '../pool.js';
import type { DbWriteReq, DbWriteRes, PersistAssistantTurnPayload } from './protocol.js';

export interface DbWriter {
  persistAssistantTurn(payload: PersistAssistantTurnPayload): Promise<number>;
  drainSession(sessionId: number): Promise<void>;
  drainAll(): Promise<void>;
  close(): Promise<void>;
}

const createWorkerDbWriter = (dbPath: string): DbWriter => {
  // size=1: better-sqlite3 single-writer model. Multiple workers writing the
  // same file would just contend on the WAL writer lock with extra IPC cost.
  const pool: Pool<DbWriteReq, DbWriteRes> = createPool({
    workerUrl: resolveWorkerUrl(import.meta.url, './worker'),
    size: 1,
    workerData: { dbPath },
  });

  // Per-session FIFO chain. The single worker already serializes, but chaining
  // here also gives us a per-session drain primitive callers can await before
  // closing a session.
  const sessionChains = new Map<number, Promise<unknown>>();

  return {
    persistAssistantTurn(payload) {
      const sessionId = payload.session_id;
      const prior = sessionChains.get(sessionId) ?? Promise.resolve();
      const next = prior
        .then(() => pool.dispatch({ kind: 'persistAssistantTurn', payload }))
        .then((res) => {
          if (res.kind !== 'persistAssistantTurn') {
            throw new Error(`unexpected dbWriter response: ${res.kind}`);
          }
          return res.messageId;
        });
      // Swallow rejection in the stored chain so a single failure does not
      // poison subsequent persists for the same session. Caller still sees
      // the rejection on the returned `next` promise.
      sessionChains.set(sessionId, next.catch(() => undefined));
      return next;
    },

    async drainSession(sessionId) {
      const chain = sessionChains.get(sessionId);
      if (!chain) return;
      try { await chain; } catch { /* errors surfaced to caller of persist */ }
      // Only delete if we are still the latest (avoid clobbering a later submission).
      if (sessionChains.get(sessionId) === chain) {
        sessionChains.delete(sessionId);
      }
    },

    async drainAll() {
      const chains = Array.from(sessionChains.values());
      await Promise.allSettled(chains);
      sessionChains.clear();
      await pool.drain();
    },

    async close() {
      await this.drainAll();
      await pool.close();
    },
  };
};

let singleton: { dbPath: string; writer: DbWriter } | null = null;

export const getDbWriter = (dbPath: string): DbWriter => {
  if (singleton && singleton.dbPath !== dbPath) {
    throw new Error(
      `dbWriter already opened against ${singleton.dbPath}; cannot reuse for ${dbPath}`,
    );
  }
  if (!singleton) {
    singleton = { dbPath, writer: createWorkerDbWriter(dbPath) };
  }
  return singleton.writer;
};

export const closeDbWriter = async (): Promise<void> => {
  if (!singleton) return;
  const w = singleton.writer;
  singleton = null;
  await w.close();
};

export const isDbWriterEnabled = (): boolean => process.env.MCP_DB_WORKER === '1';

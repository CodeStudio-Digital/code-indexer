/**
 * MongoDB driver (`mongodb`, pure JS — fetched on demand via resolveDriverEntry).
 * A DOCUMENT store: it does NOT speak the relational SQL surface, so the SQL
 * methods (runQuery/tablePreview/describeTable/…) throw and ALL work goes through
 * `runCommand` (find / aggregate / listCollections / insert / update / delete).
 * Docs are JSON-normalized (ObjectId → hex, Date → ISO) so they survive the IPC
 * structured-clone and render in the grid; edits target `_id`.
 *
 * NOTE: written against the mongodb v6 API but NOT verified against a live server.
 */
import { DEFAULT_MAX_ROWS } from './types.js';
import { resolveDriverEntry } from './driver-registry.js';
import { assertDatabaseDispatch } from './dispatch.js';
import { readCursorWindow, readDocumentWindow, type DatabaseCursor } from './bounded-cursor.js';
import { isWriteCommand } from './command-classify.js';
import type { DatabaseDriver, DbCommand, DbConnectConfig, QueryResult, RunQueryOptions } from './types.js';

interface MongoCursor<T> extends DatabaseCursor<T> { toArray(): Promise<T[]> }
interface MongoCollection {
  find(filter: unknown, opts?: Record<string, unknown>): MongoCursor<Record<string, unknown>>;
  aggregate(pipeline: unknown[], opts?: Record<string, unknown>): MongoCursor<Record<string, unknown>>;
  insertOne(doc: Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  insertMany(docs: Array<Record<string, unknown>>, opts?: Record<string, unknown>): Promise<{ insertedCount: number; insertedIds: Record<string, unknown> }>;
  updateOne(filter: unknown, update: unknown, opts?: Record<string, unknown>): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteOne(filter: unknown, opts?: Record<string, unknown>): Promise<{ deletedCount: number }>;
  countDocuments(filter?: unknown, opts?: Record<string, unknown>): Promise<number>;
  listIndexes(opts?: Record<string, unknown>): MongoCursor<Record<string, unknown>>;
}
interface MongoDb {
  listCollections(filter?: unknown, opts?: unknown): MongoCursor<{ name: string; type?: string }>;
  collection(name: string): MongoCollection;
  command(cmd: Record<string, unknown>, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
  admin(): { listDatabases(): Promise<{ databases: Array<{ name: string }> }> };
}
interface MongoClientT {
  connect(): Promise<MongoClientT>;
  db(name?: string): MongoDb;
  close(): Promise<void>;
}
interface MongoModule {
  MongoClient: new (uri: string, opts?: Record<string, unknown>) => MongoClientT;
  ObjectId: new (id?: string) => unknown;
}

const HEX24 = /^[a-f0-9]{24}$/i;

function buildUri(config: DbConnectConfig): string {
  if (config.connectionString) return config.connectionString;
  const auth = config.user ? `${encodeURIComponent(config.user)}:${encodeURIComponent(config.password ?? '')}@` : '';
  const host = config.host ?? 'localhost';
  const port = config.port ?? 27017;
  return `mongodb://${auth}${host}:${port}/`;
}

/** Union of top-level keys across the page → grid columns (with `_id` first). */
function fieldsOf(rows: Array<Record<string, unknown>>): Array<{ name: string }> {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) set.add(k);
  const names = [...set];
  names.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : a.localeCompare(b)));
  return names.map((name) => ({ name }));
}

export async function createMongoDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  let mod: { default?: MongoModule } & MongoModule;
  try {
    mod = (await import(resolveDriverEntry('mongodb'))) as typeof mod;
  } catch {
    throw new Error('mongodb driver not installed — download it from the connection dialog');
  }
  const mongo: MongoModule = mod.default ?? mod;
  const client = await new mongo.MongoClient(buildUri(config), { serverSelectionTimeoutMS: 10_000 }).connect();

  /**
   * JSON-normalize a doc for IPC + grid render. The top-level `_id` is tagged as
   * Extended JSON `{ $oid: hex }` when it's an ObjectId, so the round-trip is
   * unambiguous (a genuine 24-hex STRING id stays a string — the old bare-hex
   * heuristic mis-revived those). Date → ISO and nested ObjectId → hex via
   * JSON.stringify (display-only; the editable key is `_id`).
   */
  function normalizeDoc(doc: Record<string, unknown>): Record<string, unknown> {
    const isOid = doc._id instanceof mongo.ObjectId;
    const oidHex = isOid ? String(doc._id) : null;
    const out = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    if (isOid && oidHex) out._id = { $oid: oidHex };
    return out;
  }

  /** Coerce a tagged `{ $oid }` (or legacy bare 24-hex string) `_id` back to ObjectId. */
  function reviveId(filter: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!filter) return {};
    const id = filter._id as unknown;
    if (id && typeof id === 'object' && typeof (id as { $oid?: unknown }).$oid === 'string' && HEX24.test((id as { $oid: string }).$oid)) {
      return { ...filter, _id: new mongo.ObjectId((id as { $oid: string }).$oid) };
    }
    return filter;
  }

  async function runCommand(command: DbCommand, opts: RunQueryOptions = {}): Promise<QueryResult> {
    assertDatabaseDispatch(opts);
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const dispatchOptions = { signal: opts.signal, ...(opts.timeoutMs ? { maxTimeMS: opts.timeoutMs } : {}) };
    const p = (command.payload ?? {}) as Record<string, unknown>;
    const db = client.db((p.database as string) || config.database || undefined);

    if (command.op === 'listCollections') {
      const page = await readCursorWindow(db.listCollections({}, { ...dispatchOptions, nameOnly: true }), max, opts);
      const rows = page.rows.map((c) => ({ name: c.name, type: c.type ?? 'collection' }));
      return { ...page, rows, fields: [{ name: 'name' }, { name: 'type' }] };
    }

    const coll = db.collection(command.collection ?? '');
    if (command.op === 'find') {
      const page = await readDocumentWindow(coll.find(p.filter ?? {}, { ...dispatchOptions,
        sort: p.sort, skip: Number(p.skip ?? 0), limit: max + 1 }), max, opts, normalizeDoc);
      const rows = page.rows;
      return { ...page, rows, fields: fieldsOf(rows) };
    }
    if (command.op === 'aggregate') {
      const page = await readDocumentWindow(coll.aggregate((p.pipeline as unknown[]) ?? [], dispatchOptions),
        max, opts, normalizeDoc, isWriteCommand(command));
      const rows = page.rows;
      return { ...page, rows, fields: fieldsOf(rows) };
    }
    if (command.op === 'countDocuments') {
      const n = await coll.countDocuments(p.filter ?? {}, dispatchOptions);
      return { rows: [{ count: n }], rowCount: n, fields: [{ name: 'count' }] };
    }
    if (command.op === 'listIndexes') {
      const page = await readCursorWindow(coll.listIndexes(dispatchOptions), max, opts);
      const rows = page.rows.map((i) => ({ name: i.name, keys: JSON.stringify(i.key ?? {}), unique: !!i.unique }));
      return { ...page, rows, fields: [{ name: 'name' }, { name: 'keys' }, { name: 'unique' }] };
    }
    if (command.op === 'stats') {
      const s = await db.command({ collStats: command.collection ?? '' }, dispatchOptions);
      const pick = ['ns', 'count', 'size', 'storageSize', 'avgObjSize', 'nindexes', 'totalIndexSize', 'capped'];
      const rows = pick.filter((k) => k in s).map((k) => ({ stat: k, value: s[k] as unknown }));
      return { rows, rowCount: rows.length, fields: [{ name: 'stat' }, { name: 'value' }] };
    }
    if (command.op === 'insertOne') {
      const res = await coll.insertOne(reviveId((p.document as Record<string, unknown>) ?? {}), dispatchOptions);
      return { rows: [], rowCount: 1, fields: [], command: `inserted ${String(res.insertedId)}` };
    }
    if (command.op === 'insertMany') {
      // Bulk import: revive any tagged `{ $oid }` _id so a re-imported export keeps
      // its ObjectId identity; docs without _id get a server-assigned one.
      const docs = ((p.documents as unknown[]) ?? []).map((d) => reviveId(d as Record<string, unknown>));
      if (docs.length === 0) return { rows: [], rowCount: 0, fields: [], command: 'inserted 0' };
      const res = await coll.insertMany(docs, dispatchOptions);
      const n = res.insertedCount ?? Object.keys(res.insertedIds ?? {}).length;
      return { rows: [], rowCount: n, fields: [], command: `inserted ${n}` };
    }
    if (command.op === 'updateOne') {
      const res = await coll.updateOne(reviveId(p.filter as Record<string, unknown>), { $set: (p.update as Record<string, unknown>) ?? {} }, dispatchOptions);
      // rowCount = matchedCount so the UI can detect a filter that hit nothing
      // (modifiedCount can be 0 on a legitimate no-op save).
      return { rows: [], rowCount: res.matchedCount, fields: [], command: 'updated' };
    }
    if (command.op === 'deleteOne') {
      const res = await coll.deleteOne(reviveId(p.filter as Record<string, unknown>), dispatchOptions);
      return { rows: [], rowCount: res.deletedCount, fields: [], command: 'deleted' };
    }
    throw new Error(`unsupported mongo op: ${command.op}`);
  }

  const unsupported = (): never => {
    throw new Error('Not supported for a document store — use the document view.');
  };

  const driver: DatabaseDriver = {
    kind: 'document',
    async testConnection() {
      await client.db(config.database || 'admin').command({ ping: 1 }); // throws if unreachable
      const info = await client.db('admin').command({ buildInfo: 1 }).catch(() => ({}) as Record<string, unknown>);
      return { serverVersion: typeof info.version === 'string' ? info.version : undefined };
    },
    async listDatabases() {
      const res = await client.db('admin').admin().listDatabases();
      return res.databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    },
    async listSchemas() {
      return [];
    },
    async listTables() {
      return [];
    },
    describeTable: unsupported,
    async listObjects() {
      return [];
    },
    tablePreview: unsupported,
    async schema() {
      return [];
    },
    runQuery: unsupported,
    query: unsupported,
    runCommand,
    async close() {
      await client.close();
    },
  };
  return driver;
}

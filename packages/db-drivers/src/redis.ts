/**
 * Redis driver (`ioredis`, pure JS — fetched on demand via resolveDriverEntry).
 * A KEY-VALUE store: no SQL surface, so the relational methods throw and work
 * goes through `runCommand` — scan (keyspace browse), get (type-aware value),
 * set / del / expire. Each op is a pipeline `SELECT <db> + <cmd>` so the logical
 * db is applied atomically (one shared connection, no cross-tab SELECT race).
 *
 * NOTE: written against the ioredis v5 API but NOT verified against a live server.
 */
import { DEFAULT_MAX_ROWS } from './types.js';
import { resolveDriverEntry } from './driver-registry.js';
import type { DatabaseDriver, DbCommand, DbConnectConfig, QueryResult, RunQueryOptions } from './types.js';

type PipeResult = Array<[Error | null, unknown]> | null;
interface RedisPipeline {
  select(db: number): RedisPipeline;
  scan(cursor: string, ...args: unknown[]): RedisPipeline;
  type(key: string): RedisPipeline;
  pttl(key: string): RedisPipeline;
  ttl(key: string): RedisPipeline;
  get(key: string): RedisPipeline;
  hgetall(key: string): RedisPipeline;
  lrange(key: string, start: number, stop: number): RedisPipeline;
  smembers(key: string): RedisPipeline;
  zrange(key: string, start: number, stop: number, withScores: string): RedisPipeline;
  set(key: string, value: string): RedisPipeline;
  expire(key: string, seconds: number): RedisPipeline;
  persist(key: string): RedisPipeline;
  del(key: string): RedisPipeline;
  // Field-level writers for the complex-type editor.
  hset(key: string, field: string, value: string): RedisPipeline;
  hdel(key: string, field: string): RedisPipeline;
  lset(key: string, index: number, value: string): RedisPipeline;
  lpush(key: string, value: string): RedisPipeline;
  rpush(key: string, value: string): RedisPipeline;
  lrem(key: string, count: number, value: string): RedisPipeline;
  sadd(key: string, member: string): RedisPipeline;
  srem(key: string, member: string): RedisPipeline;
  zadd(key: string, score: number | string, member: string): RedisPipeline;
  zrem(key: string, member: string): RedisPipeline;
  rename(key: string, newKey: string): RedisPipeline;
  exec(): Promise<PipeResult>;
}
interface RedisClient {
  pipeline(): RedisPipeline;
  info(section?: string): Promise<string>;
  ping(): Promise<string>;
  /** Run an arbitrary command (the RESP console). select() is issued first on the same client. */
  select(db: number): Promise<unknown>;
  call(command: string, ...args: unknown[]): Promise<unknown>;
  quit(): Promise<unknown>;
}
interface RedisModule {
  default: new (uri: string | Record<string, unknown>, opts?: Record<string, unknown>) => RedisClient;
}

/** Coerce a RESP reply into IPC-clonable values (Buffer → utf8 string, recurse arrays). */
function normalizeReply(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'object' && v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  if (Array.isArray(v)) return v.map(normalizeReply);
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function clientOpts(config: DbConnectConfig): string | Record<string, unknown> {
  if (config.connectionString) return config.connectionString;
  return {
    host: config.host ?? 'localhost',
    port: config.port ?? 6379,
    password: config.password || undefined,
    username: config.user || undefined,
    maxRetriesPerRequest: 1,
    connectTimeout: typeof config.options?.connectTimeoutMs === 'number' ? config.options.connectTimeoutMs : 10_000,
  };
}

export async function createRedisDriver(config: DbConnectConfig): Promise<DatabaseDriver> {
  let mod: RedisModule & { default?: RedisModule['default'] };
  try {
    mod = (await import(resolveDriverEntry('redis'))) as typeof mod;
  } catch {
    throw new Error('redis driver not installed — download it from the connection dialog');
  }
  const Ctor = mod.default ?? (mod as unknown as RedisModule['default']);
  const redis = new Ctor(clientOpts(config));

  /** The op result from a `pipeline().select(db).<op>()` — index 1 (0 is SELECT). */
  function opResult(res: PipeResult, i = 1): unknown {
    const entry = res?.[i];
    if (!entry) return undefined;
    if (entry[0]) throw entry[0];
    return entry[1];
  }

  async function runCommand(command: DbCommand, opts: RunQueryOptions = {}): Promise<QueryResult> {
    const max = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const p = (command.payload ?? {}) as Record<string, unknown>;
    const db = Number(p.db ?? 0);

    if (command.op === 'scan') {
      const res = await redis
        .pipeline()
        .select(db)
        .scan(String(p.cursor ?? '0'), 'MATCH', String(p.match || '*'), 'COUNT', Math.min(max, 1000))
        .exec();
      const [nextCursor, keys] = (opResult(res) as [string, string[]]) ?? ['0', []];
      // Fetch each key's type + TTL in one round trip.
      const metaPipe = redis.pipeline().select(db);
      for (const k of keys) {
        metaPipe.type(k);
        metaPipe.ttl(k);
      }
      const meta = await metaPipe.exec();
      const rows = keys.map((k, i) => ({
        key: k,
        type: opResult(meta, 1 + i * 2),
        ttl: opResult(meta, 2 + i * 2),
      }));
      return { rows, rowCount: rows.length, fields: [{ name: 'key' }, { name: 'type' }, { name: 'ttl' }], cursor: String(nextCursor) };
    }

    const key = String(p.key ?? '');
    if (command.op === 'get') {
      const head = await redis.pipeline().select(db).type(key).pttl(key).exec();
      const type = String(opResult(head, 1) ?? 'none');
      const pttl = Number(opResult(head, 2) ?? -1);
      const vp = redis.pipeline().select(db);
      if (type === 'string') vp.get(key);
      else if (type === 'hash') vp.hgetall(key);
      else if (type === 'list') vp.lrange(key, 0, -1);
      else if (type === 'set') vp.smembers(key);
      else if (type === 'zset') vp.zrange(key, 0, -1, 'WITHSCORES');
      else vp.get(key);
      const value = opResult(await vp.exec());
      const ttl = pttl >= 0 ? Math.floor(pttl / 1000) : pttl; // seconds; -1 none, -2 missing
      return { rows: [{ key, type, ttl, value }], rowCount: 1, fields: [{ name: 'key' }, { name: 'type' }, { name: 'ttl' }, { name: 'value' }] };
    }
    if (command.op === 'set') {
      const pipe = redis.pipeline().select(db).set(key, String(p.value ?? ''));
      if (typeof p.ttl === 'number' && p.ttl > 0) pipe.expire(key, Number(p.ttl));
      await pipe.exec();
      return { rows: [], rowCount: 1, fields: [], command: 'OK' };
    }
    if (command.op === 'expire') {
      const ttl = Number(p.ttl ?? -1);
      const pipe = redis.pipeline().select(db);
      if (ttl > 0) pipe.expire(key, ttl);
      else pipe.persist(key);
      await pipe.exec();
      return { rows: [], rowCount: 1, fields: [], command: 'OK' };
    }
    if (command.op === 'del') {
      const res = await redis.pipeline().select(db).del(key).exec();
      return { rows: [], rowCount: Number(opResult(res) ?? 0), fields: [], command: 'deleted' };
    }
    if (command.op === 'rename') {
      // RENAME throws if the source key is missing — let that surface to the UI.
      await redis.pipeline().select(db).rename(key, String(p.newKey ?? '')).exec();
      return { rows: [], rowCount: 1, fields: [], command: 'renamed' };
    }

    // ── Field-level edits for complex types (hash / list / set / zset) ──────
    const ok = (cmd: string): QueryResult => ({ rows: [], rowCount: 1, fields: [], command: cmd });
    const counted = (res: PipeResult, cmd: string): QueryResult => ({ rows: [], rowCount: Number(opResult(res) ?? 0), fields: [], command: cmd });
    if (command.op === 'hset') {
      await redis.pipeline().select(db).hset(key, String(p.field ?? ''), String(p.value ?? '')).exec();
      return ok('OK');
    }
    if (command.op === 'hdel') {
      return counted(await redis.pipeline().select(db).hdel(key, String(p.field ?? '')).exec(), 'deleted');
    }
    if (command.op === 'lset') {
      await redis.pipeline().select(db).lset(key, Number(p.index ?? 0), String(p.value ?? '')).exec();
      return ok('OK');
    }
    if (command.op === 'lpush' || command.op === 'rpush') {
      const pipe = redis.pipeline().select(db);
      if (command.op === 'lpush') pipe.lpush(key, String(p.value ?? ''));
      else pipe.rpush(key, String(p.value ?? ''));
      await pipe.exec();
      return ok('OK');
    }
    if (command.op === 'lrem') {
      return counted(await redis.pipeline().select(db).lrem(key, Number(p.count ?? 0), String(p.value ?? '')).exec(), 'deleted');
    }
    if (command.op === 'ldel') {
      // Delete a list element by INDEX (not value — LREM-by-value removes the wrong
      // entry when the list has duplicates): set the slot to a unique sentinel, then
      // LREM the sentinel. Both run on the one shared connection.
      const sentinel = `__mcp_del__${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await redis.pipeline().select(db).lset(key, Number(p.index ?? 0), sentinel).lrem(key, 1, sentinel).exec();
      return ok('deleted');
    }
    if (command.op === 'sadd') {
      return counted(await redis.pipeline().select(db).sadd(key, String(p.member ?? '')).exec(), 'added');
    }
    if (command.op === 'srem') {
      return counted(await redis.pipeline().select(db).srem(key, String(p.member ?? '')).exec(), 'deleted');
    }
    if (command.op === 'zadd') {
      return counted(await redis.pipeline().select(db).zadd(key, Number(p.score ?? 0), String(p.member ?? '')).exec(), 'added');
    }
    if (command.op === 'zrem') {
      return counted(await redis.pipeline().select(db).zrem(key, String(p.member ?? '')).exec(), 'deleted');
    }

    // ── Raw RESP command console ───────────────────────────────────────────
    if (command.op === 'raw') {
      const args = (command.args ?? []).map((a) => String(a));
      if (args.length === 0) throw new Error('empty command');
      const [cmd, ...rest] = args;
      await redis.select(db); // scope to the chosen logical db on this shared client
      const reply = await redis.call(cmd, ...rest);
      const norm = normalizeReply(reply);
      // A multi-bulk reply (array) becomes one row per element; a scalar is one row.
      const rows = Array.isArray(norm)
        ? norm.map((v, i) => ({ '#': i + 1, value: v }))
        : [{ '#': 1, value: norm }];
      return { rows, rowCount: rows.length, fields: [{ name: '#' }, { name: 'value' }], command: cmd.toUpperCase() };
    }
    throw new Error(`unsupported redis op: ${command.op}`);
  }

  const unsupported = (): never => {
    throw new Error('Not supported for a key-value store — use the key browser.');
  };

  const driver: DatabaseDriver = {
    kind: 'keyvalue',
    async testConnection() {
      await redis.ping();
      const info = await redis.info('server').catch(() => '');
      const m = /redis_version:([^\r\n]+)/.exec(info);
      return { serverVersion: m?.[1] };
    },
    async listDatabases() {
      // INFO keyspace lists only non-empty logical dbs (db0:keys=…); always show db0.
      const info = await redis.info('keyspace').catch(() => '');
      const dbs = new Set<string>(['0']);
      for (const m of info.matchAll(/^db(\d+):/gm)) dbs.add(m[1]);
      return [...dbs].sort((a, b) => Number(a) - Number(b));
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
      await redis.quit().catch(() => undefined);
    },
  };
  return driver;
}

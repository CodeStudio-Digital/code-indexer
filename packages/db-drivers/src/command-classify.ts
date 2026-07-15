/**
 * Read/write classification for NON-relational commands. The relational
 * read-only valve is a SQL-keyword classifier (in the handler) and does not
 * apply to Mongo/Redis — those must be classified per engine here, or a
 * read-only connection would silently allow writes.
 *
 * Conservative by design: an UNKNOWN op/command counts as a WRITE, so a
 * read-only connection refuses anything we can't prove is read-only.
 */
import type { DbCommand } from './types.js';

/** Mongo operations that read only (everything else — insert/update/delete/drop/createIndex/… — is a write). */
const MONGO_READ_OPS = new Set([
  'find', 'findone', 'aggregate', 'count', 'countdocuments', 'estimateddocumentcount',
  'distinct', 'listcollections', 'listindexes', 'stats', 'explain',
]);

/** Redis commands that read only. Anything not here is treated as a write. */
/** Op-style keyvalue verbs the driver emits that only READ (everything else writes). */
const REDIS_READ_OPS = new Set(['scan', 'get', 'type', 'ttl', 'pttl', 'exists', 'keys']);

const REDIS_READ_CMDS = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN', 'RANDOMKEY', 'DBSIZE',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSCAN', 'HSTRLEN',
  'LRANGE', 'LINDEX', 'LLEN',
  'SMEMBERS', 'SISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZCOUNT',
  // DEBUG and MEMORY are deliberately absent: their subcommands include
  // server-mutating operations (for example DEBUG RELOAD / MEMORY PURGE).
  'GETRANGE', 'BITCOUNT', 'GETBIT', 'OBJECT', 'INFO', 'PING', 'ECHO', 'XRANGE', 'XLEN', 'XREVRANGE',
]);

/** `$out` / `$merge` make an aggregation pipeline write to a collection. */
function mongoAggregateWrites(payload: unknown): boolean {
  const stack: unknown[] = [payload];
  const seen = new WeakSet<object>();
  let inspected = 0;
  while (stack.length > 0) {
    if (++inspected > 10_000) return true; // fail closed on pathological input
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$out' || key === '$merge') return true;
      stack.push(child);
    }
  }
  return false;
}

/** True when a non-relational command MUTATES state (used by the read-only guard). */
export function isWriteCommand(command: DbCommand): boolean {
  if (command.kind === 'document') {
    const op = (command.op ?? '').toLowerCase();
    if (op === 'aggregate') return mongoAggregateWrites(command.payload);
    return !MONGO_READ_OPS.has(op);
  }
  if (command.kind === 'keyvalue') {
    // The driver/UI send op-style commands (scan/get/set/del/expire/hset/…). The
    // RESP console sends op 'raw' carrying the real command in args[0] — classify
    // THAT (so e.g. GET is allowed, FLUSHDB blocked, on a read-only connection).
    const op = (command.op ?? '').toLowerCase();
    if (op && op !== 'raw') return !REDIS_READ_OPS.has(op);
    const cmd = (command.args?.[0] ?? '').toUpperCase();
    return !REDIS_READ_CMDS.has(cmd);
  }
  return true;
}

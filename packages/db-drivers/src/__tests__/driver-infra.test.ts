import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  DB_DRIVER_REGISTRY, driverDefFor, driverInstallDir, isDriverInstalled, resolveDriverEntry,
} from '../driver-registry.js';
import { isWriteCommand } from '../command-classify.js';

const BASE = join('/tmp', 'mcp-db-drivers-test-nonexistent');

describe('driver registry', () => {
  it('catalogs the on-demand engines with pinned versions', () => {
    expect(DB_DRIVER_REGISTRY.map((d) => d.engine).sort()).toEqual(['mongodb', 'oracle', 'redis']);
    const mongo = driverDefFor('mongodb');
    expect(mongo?.package).toBe('mongodb');
    expect(mongo?.kind).toBe('document');
    expect(driverDefFor('redis')?.kind).toBe('keyvalue');
    expect(driverDefFor('oracle')?.kind).toBe('relational');
    expect(driverDefFor('postgres')).toBeUndefined(); // bundled, not lazy
  });

  it('derives a versioned install dir and reports not-installed for a fresh base', () => {
    const def = driverDefFor('mongodb')!;
    expect(driverInstallDir(def, BASE)).toBe(join(BASE, `mongodb@${def.version}`));
    expect(isDriverInstalled(def, BASE)).toBe(false);
  });

  it('resolveDriverEntry falls back to the bare package name when not installed', () => {
    expect(resolveDriverEntry('mongodb', BASE)).toBe('mongodb');
    expect(resolveDriverEntry('redis', BASE)).toBe('ioredis');
    expect(resolveDriverEntry('postgres', BASE)).toBe('postgres'); // no registry entry → bare engine name
  });
});

describe('non-relational read/write classification', () => {
  it('classifies Mongo ops (reads vs writes), defaulting unknown to write', () => {
    expect(isWriteCommand({ kind: 'document', op: 'find' })).toBe(false);
    expect(isWriteCommand({ kind: 'document', op: 'aggregate' })).toBe(false);
    expect(isWriteCommand({ kind: 'document', op: 'aggregate', payload: { pipeline: [{ $out: 'archive' }] } })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'aggregate', payload: { pipeline: [{ $merge: { into: 'archive' } }] } })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'insertOne' })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'deleteMany' })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'whoKnows' })).toBe(true);
  });

  it('classifies Redis op-style commands (the real contract), defaulting unknown to write', () => {
    // The driver/UI send { kind:'keyvalue', op:'scan'|'get'|'set'|'del'|'expire' }.
    expect(isWriteCommand({ kind: 'keyvalue', op: 'scan' })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'get' })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'set' })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'del' })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'expire' })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'whoKnows' })).toBe(true);
    // Fallback: a raw RESP command via args[0] still classifies.
    expect(isWriteCommand({ kind: 'keyvalue', args: ['GET', 'k'] })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', args: ['FLUSHDB'] })).toBe(true);
  });

  it('classifies the RESP console (op:raw) by its real command, not the op name', () => {
    // op 'raw' must defer to args[0] so reads run on a read-only connection.
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['GET', 'k'] })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['HGETALL', 'h'] })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['SET', 'k', 'v'] })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['FLUSHALL'] })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['DEBUG', 'RELOAD'] })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', op: 'raw', args: ['MEMORY', 'PURGE'] })).toBe(true);
  });

  it('classifies complex-type + rename writers as writes', () => {
    for (const op of ['hset', 'hdel', 'lset', 'lpush', 'rpush', 'lrem', 'sadd', 'srem', 'zadd', 'zrem', 'rename']) {
      expect(isWriteCommand({ kind: 'keyvalue', op })).toBe(true);
    }
  });
});

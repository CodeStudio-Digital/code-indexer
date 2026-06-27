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
    expect(isWriteCommand({ kind: 'document', op: 'insertOne' })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'deleteMany' })).toBe(true);
    expect(isWriteCommand({ kind: 'document', op: 'whoKnows' })).toBe(true);
  });

  it('classifies Redis commands (reads vs writes), defaulting unknown to write', () => {
    expect(isWriteCommand({ kind: 'keyvalue', args: ['GET', 'k'] })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', args: ['hgetall', 'h'] })).toBe(false);
    expect(isWriteCommand({ kind: 'keyvalue', args: ['SET', 'k', 'v'] })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', args: ['FLUSHDB'] })).toBe(true);
    expect(isWriteCommand({ kind: 'keyvalue', args: [] })).toBe(true);
  });
});

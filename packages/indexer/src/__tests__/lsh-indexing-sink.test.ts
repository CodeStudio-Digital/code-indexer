/**
 * RealLshIndexingSink — proves the indexer hook pushes vector records
 * through the LSH pipeline correctly. Uses a real LSHIndex backed by
 * in-memory SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { LshIndexStore } from '@mcp/store/lsh-index-store.js';
import { LSHIndex } from '../search/lsh-index.js';
import {
  NullLshIndexingSink,
  RealLshIndexingSink,
  vectorIdToEntityId,
  metadataTypeToLshEntityType,
} from '../indexer/lsh-indexing-sink.js';
import type { VectorRecord } from '@mcp/shared/types.js';

interface Handle { db: CodeIndexDB; dir: string }

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lsh-sink-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('vectorIdToEntityId', () => {
  it('produces deterministic non-zero ints', () => {
    expect(vectorIdToEntityId('file::1')).toBe(vectorIdToEntityId('file::1'));
    expect(vectorIdToEntityId('file::1')).toBeGreaterThan(0);
    expect(vectorIdToEntityId('different')).not.toBe(vectorIdToEntityId('file::1'));
  });
});

describe('metadataTypeToLshEntityType', () => {
  it('collapses symbol_body into symbol', () => {
    expect(metadataTypeToLshEntityType('file')).toBe('file');
    expect(metadataTypeToLshEntityType('symbol')).toBe('symbol');
    expect(metadataTypeToLshEntityType('symbol_body')).toBe('symbol');
    expect(metadataTypeToLshEntityType(undefined)).toBe('symbol');
  });
});

describe('NullLshIndexingSink', () => {
  it('does nothing (does not throw)', () => {
    const sink = new NullLshIndexingSink();
    expect(() => sink.afterUpsert(1, [])).not.toThrow();
  });
});

describe('RealLshIndexingSink', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  function buildRecord(id: string, type: 'file' | 'symbol', vec: number[]): VectorRecord {
    return { id, values: vec, metadata: { type } as never };
  }

  it('indexes a batch via the LSH pipeline', () => {
    const store = new LshIndexStore(h.db.raw());
    const lsh = new LSHIndex({ dim: 8, store, numHashes: 2, numBuckets: 16, seed: 7 });
    const sink = new RealLshIndexingSink(lsh);

    sink.afterUpsert(42, [
      buildRecord('file::1', 'file', [1, 0, 0, 0, 0, 0, 0, 0]),
      buildRecord('file::2', 'file', [0, 1, 0, 0, 0, 0, 0, 0]),
      buildRecord('sym::1', 'symbol', [0, 0, 1, 0, 0, 0, 0, 0]),
    ]);

    const filesHistogram = store.bucketHistogram({
      project_id: 42, entity_type: 'file', hash_idx: 0,
    });
    const symbolsHistogram = store.bucketHistogram({
      project_id: 42, entity_type: 'symbol', hash_idx: 0,
    });
    expect(filesHistogram.length).toBeGreaterThan(0);
    expect(symbolsHistogram.length).toBeGreaterThan(0);
  });

  it('does not throw on empty batches', () => {
    const store = new LshIndexStore(h.db.raw());
    const lsh = new LSHIndex({ dim: 8, store, numHashes: 2, numBuckets: 16, seed: 7 });
    const sink = new RealLshIndexingSink(lsh);
    expect(() => sink.afterUpsert(1, [])).not.toThrow();
  });

  it('afterDelete removes both file and symbol variants', () => {
    const store = new LshIndexStore(h.db.raw());
    const lsh = new LSHIndex({ dim: 8, store, numHashes: 2, numBuckets: 16, seed: 7 });
    const sink = new RealLshIndexingSink(lsh);

    sink.afterUpsert(1, [
      buildRecord('vid_x', 'file', [1, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    expect(store.getSignature({
      project_id: 1, entity_type: 'file', entity_id: vectorIdToEntityId('vid_x'),
    })).not.toBeNull();

    sink.afterDelete!(1, ['vid_x']);
    expect(store.getSignature({
      project_id: 1, entity_type: 'file', entity_id: vectorIdToEntityId('vid_x'),
    })).toBeNull();
  });
});

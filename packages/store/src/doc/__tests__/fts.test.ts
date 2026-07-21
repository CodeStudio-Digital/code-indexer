import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeIndexDB } from '../../db.js';
import { DocStore } from '../../doc-store.js';
import { createDocChunksFtsIfReady } from '../../db/schema/fts.js';

describe('documentation FTS recall fallback', () => {
  let dir: string;
  let db: CodeIndexDB;
  let store: DocStore;
  let collectionId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-doc-fts-test-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    createDocChunksFtsIfReady(db.raw());
    store = new DocStore(db.raw());
    const collection = store.createCollection({ name: 'unity-docs' });
    collectionId = collection.id;
    const source = store.createSource({
      collection_id: collection.id,
      type: 'url',
      uri: 'https://docs.example.test/unity',
    });
    store.insertChunks([
      {
        collection_id: collection.id,
        source_id: source.id,
        ord: 0,
        heading_path: 'EditorWindow.CreateGUI',
        content: 'Create an EditorWindow interface with CreateGUI and VisualElement.',
        content_hash: 'chunk-a',
      },
      {
        collection_id: collection.id,
        source_id: source.id,
        ord: 1,
        heading_path: 'Scheduling',
        content: 'Schedule Execute callbacks from the main thread.',
        content_hash: 'chunk-b',
      },
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('relaxes a zero-hit multi-term AND query to ranked OR matches', () => {
    const hits = store.searchChunksFts(
      'EditorWindow CreateGUI VisualElement schedule Execute main thread',
      { collectionIds: [collectionId], limit: 8 },
    );

    expect(hits).toHaveLength(2);
  });

  it('keeps strict AND results when they exist', () => {
    const hits = store.searchChunksFts('EditorWindow CreateGUI', {
      collectionIds: [collectionId],
      limit: 8,
    });

    expect(hits).toHaveLength(1);
  });
});

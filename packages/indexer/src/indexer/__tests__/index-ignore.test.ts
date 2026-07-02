import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import { makeHarness, smallFileFixture, type Harness } from './index-agent-harness.js';
import { purgeIgnoredIndexedFiles } from '../purge-ignored.js';
import { NullLshIndexingSink } from '../lsh-indexing-sink.js';

describe('project index ignore rules', () => {
  let h: Harness | null = null;

  afterEach(() => {
    h?.dispose();
    h = null;
  });

  it('full index removes files after they become project-ignored', async () => {
    h = makeHarness();
    mkdirSync(join(h.projectRoot, 'generated'));
    h.writeFile('keep.ts', smallFileFixture('keepFn'));
    h.writeFile('generated/client.ts', smallFileFixture('generatedFn'));

    await h.agent.indexProject(h.projectRoot);
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeTruthy();
    expect(h.db.snapshotVectorIdsForProject(h.projectId).length).toBeGreaterThan(0);
    const namespace = codeNamespace('harness');
    const remoteBefore = await h.vectorStore.listIds(namespace);

    h.db.updateProject(h.projectId, { index_ignore_patterns: JSON.stringify(['generated/']) });
    await h.agent.indexProject(h.projectRoot);

    expect(h.db.getFile(h.projectId, 'keep.ts')).toBeTruthy();
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeUndefined();
    const remoteAfter = await h.vectorStore.listIds(namespace);
    expect(remoteAfter.length).toBeLessThan(remoteBefore.length);
  });

  it('purges already-indexed files that match current ignore rules', async () => {
    h = makeHarness();
    mkdirSync(join(h.projectRoot, 'generated'));
    h.writeFile('keep.ts', smallFileFixture('keepFn'));
    h.writeFile('generated/client.ts', smallFileFixture('generatedFn'));

    await h.agent.indexProject(h.projectRoot);
    h.db.updateProject(h.projectId, { index_ignore_patterns: JSON.stringify(['generated/']) });

    const result = await purgeIgnoredIndexedFiles(
      h.db,
      h.vectorStore,
      new NullLshIndexingSink(),
      h.projectId,
    );

    expect(result.matched_files).toBe(1);
    expect(result.local_deleted).toBe(1);
    expect(result.vectors_known).toBeGreaterThan(0);
    expect(result.remote_error).toBeNull();
    expect(h.db.getFile(h.projectId, 'keep.ts')).toBeTruthy();
    expect(h.db.getFile(h.projectId, 'generated/client.ts')).toBeUndefined();
  });
});

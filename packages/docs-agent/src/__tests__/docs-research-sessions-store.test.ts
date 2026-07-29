/**
 * Filesystem contract coverage for docs research sessions.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import type { SessionId } from '@mcp/session-storage';
import { DocsResearchSessionsStore } from '../session-store/docs-research-sessions-store.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let sessions: FsSessionStore;
let store: DocsResearchSessionsStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-docs-session-fs-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
    projectInfoResolver: (projectId) =>
      projectId === 7
        ? {
            project_id: 7,
            name: 'docs-fixture',
            root_path: projectRoot,
          }
        : null,
  });
  store = new DocsResearchSessionsStore(sessions);
});

afterEach(async () => {
  await sessions.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function createParent(): Promise<SessionId> {
  const parent = await sessions.createSession({
    project_id: 7,
    title: 'parent',
    provider: 'fixture',
    model: 'fixture',
  });
  return parent.id;
}

const completion = {
  status: 'completed' as const,
  num_turns: 4,
  num_searches: 2,
  num_chunks_read: 5,
  query_rewrites_used: 1,
  reranks_used: 1,
  final_markdown: '# Answer\n\nSee [^1].',
  final_chunk_ids: [101, 202],
  confidence: 'high' as const,
  input_tokens: 1234,
  output_tokens: 567,
  cost_usd: 0.018,
};

describe('DocsResearchSessionsStore.create', () => {
  it('creates a global docs bundle with running state', async () => {
    const id = await store.create({
      triggered_by: 'user',
      query: 'how to use OAuth in Next.js 15',
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      existsSync(join(dataDir, 'sessions', 'global', id, 'session.json')),
    ).toBe(true);
    const row = await store.get(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('running');
    expect(row!.query).toBe('how to use OAuth in Next.js 15');
    expect(row!.triggered_by).toBe('user');
    expect(row!.parent_coder_session_id).toBeNull();
    expect(row!.collections_json).toBeNull();
  });

  it('places coder-triggered research beside its parent bundle', async () => {
    const parentId = await createParent();
    const id = await store.create({
      triggered_by: 'coder',
      parent_coder_session_id: parentId,
      query: 'q',
      collections: ['nextjs-docs', 'next-auth-docs'],
    });

    const row = await store.get(id);
    expect(row!.parent_coder_session_id).toBe(parentId);
    expect(JSON.parse(row!.collections_json!)).toEqual([
      'nextjs-docs',
      'next-auth-docs',
    ]);
    expect(
      existsSync(
        join(projectRoot, '.mcp-indexer', 'session', id, 'state.json'),
      ),
    ).toBe(true);
  });
});

describe('DocsResearchSessionsStore.complete', () => {
  it('atomically persists telemetry and final fields in state.json', async () => {
    const id = await store.create({ triggered_by: 'user', query: 'q' });
    await store.complete(id, completion);

    const row = await store.get(id);
    expect(row!.status).toBe('completed');
    expect(row!.num_turns).toBe(4);
    expect(row!.num_searches).toBe(2);
    expect(row!.num_chunks_read).toBe(5);
    expect(row!.query_rewrites_used).toBe(1);
    expect(row!.reranks_used).toBe(1);
    expect(row!.final_markdown).toContain('Answer');
    expect(JSON.parse(row!.final_chunk_ids_json!)).toEqual([101, 202]);
    expect(row!.confidence).toBe('high');
    expect(row!.input_tokens).toBe(1234);
    expect(row!.output_tokens).toBe(567);
    expect(row!.cost_usd).toBeCloseTo(0.018);
    expect(row!.completed_at).toBeTruthy();
  });

  it('preserves an error message on failed sessions', async () => {
    const id = await store.create({ triggered_by: 'user', query: 'q' });
    await store.complete(id, {
      ...completion,
      status: 'failed',
      final_markdown: null,
      final_chunk_ids: [],
      confidence: null,
      error_message: 'No binding configured',
    });

    const row = await store.get(id);
    expect(row!.status).toBe('failed');
    expect(row!.error_message).toBe('No binding configured');
    expect(row!.final_markdown).toBeNull();
    expect(row!.final_chunk_ids_json).toBeNull();
    expect(row!.confidence).toBeNull();
  });
});

describe('DocsResearchSessionsStore.list', () => {
  it('lists docs bundles newest first and applies a limit', async () => {
    const id1 = await store.create({ triggered_by: 'user', query: 'q1' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const id2 = await store.create({ triggered_by: 'user', query: 'q2' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const id3 = await store.create({ triggered_by: 'user', query: 'q3' });

    expect((await store.list()).map((row) => row.id)).toEqual([
      id3,
      id2,
      id1,
    ]);
    expect((await store.list({ limit: 1 })).map((row) => row.id)).toEqual([
      id3,
    ]);
  });

  it('filters by parent session UUID and status', async () => {
    const parentId = await createParent();
    await store.create({ triggered_by: 'user', query: 'unrelated' });
    const own = await store.create({
      triggered_by: 'coder',
      parent_coder_session_id: parentId,
      query: 'coder-specific',
    });
    const completedId = await store.create({
      triggered_by: 'user',
      query: 'done',
    });
    await store.complete(completedId, completion);

    expect(
      (await store.list({ parentCoderSessionId: parentId })).map(
        (row) => row.id,
      ),
    ).toEqual([own]);
    expect(
      (await store.list({ status: 'completed' })).map((row) => row.id),
    ).toEqual([completedId]);
  });
});

describe('DocsResearchSessionsStore.delete', () => {
  it('moves the complete bundle to same-volume trash', async () => {
    const id = await store.create({ triggered_by: 'user', query: 'q' });
    expect(await store.delete(id)).toBe(true);
    expect(await store.get(id)).toBeNull();
    expect(
      existsSync(join(dataDir, 'sessions', 'global', id)),
    ).toBe(false);
    expect(
      existsSync(join(dataDir, 'sessions', 'global', '.trash')),
    ).toBe(true);
  });

  it('returns false for a missing UUID', async () => {
    expect(
      await store.delete('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toBe(false);
  });
});

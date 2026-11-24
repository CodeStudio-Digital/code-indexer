import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExternalSessionError,
  type PersistExternalSessionInput,
} from '../../import/types.js';
import { FsSessionStore } from '../fs-session-store.js';

let temporaryRoot: string;
let projectRoot: string;
let store: FsSessionStore;

function input(title = 'Imported'): PersistExternalSessionInput {
  return {
    project_id: 7,
    provider: 'openai',
    model: 'gpt-5',
    agent: 'build',
    title,
    source: 'codex',
    reference: {
      source: 'codex',
      source_path: 'rollout.jsonl',
      external_id: 'external-1',
    },
    document: {
      candidate: {
        source: 'codex',
        external_id: 'external-1',
        title,
        cwd: projectRoot,
        updated_at: '2026-07-14T11:00:00.000Z',
        source_model: 'gpt-5',
        source_path: 'rollout.jsonl',
        size_bytes: 42,
        reference: {
          source: 'codex',
          source_path: 'rollout.jsonl',
          external_id: 'external-1',
        },
      },
      messages: [
        {
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'continue' }],
          },
          created_at: '2026-07-14T11:00:01.000Z',
        },
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
          created_at: '2026-07-14T11:00:02.000Z',
        },
      ],
      source_summary: 'Continue.',
      fingerprint: 'abc',
      stats: {
        message_count: 2,
        user_count: 1,
        assistant_count: 1,
        tool_call_count: 0,
        tool_result_count: 0,
      },
      warnings: [],
      diagnostics: { adapter: 'codex' },
    },
    summary: {
      version: 3,
      chapter: {
        title,
        summary: 'History',
        user_requests: ['continue'],
        decisions: [],
        work_completed: ['done'],
        files: [],
        open_issues: [],
        resolved_issues: [],
      },
      resume: {
        objective: 'continue',
        current_focus: 'continue',
        constraints: [],
        pending_tasks: [],
        next_step: 'continue',
      },
    },
  };
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-import-'));
  projectRoot = join(temporaryRoot, 'project');
  const dataDir = join(temporaryRoot, 'data');
  await Promise.all([mkdir(projectRoot), mkdir(dataDir)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => id === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('filesystem external session import', () => {
  it('imports into a UUID bundle and exposes only the chapter handoff live', async () => {
    const worktree = join(temporaryRoot, 'checkout');
    await mkdir(worktree);
    const result = await store.importExternalSession({ ...input(), worktree_path: worktree });
    expect(result.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(
      await store.findImportedSession(7, 'codex', 'external-1'),
    ).toBe(result.session_id);
    expect(await store.getSession(result.session_id)).toMatchObject({
      worktree_path: worktree,
      metadata: { worktree_workspace: true },
      import_source: 'codex',
      import_external_id: 'external-1',
      import_fingerprint: 'abc',
      import_source_updated_at: '2026-07-14T11:00:00.000Z',
    });
    expect(
      (await store.loadAllSessionMessages(result.session_id))?.messages,
    ).toHaveLength(2);
    expect(
      (await store.loadSessionWithMessages(result.session_id))?.messages,
    ).toHaveLength(0);
    expect(
      (await store.listConversationChapters(result.session_id)).items[0],
    ).toMatchObject({
      source: 'import',
      start_message_seq: 1,
      end_message_seq: 2,
    });
  });

  it('rejects duplicate identities without publishing another bundle', async () => {
    await store.importExternalSession(input());
    await expect(store.importExternalSession(input())).rejects.toBeInstanceOf(
      ExternalSessionError,
    );
    expect(await store.listSessions(7, { archived: null })).toHaveLength(1);
  });

  it('moves a partially built import to recoverable trash on failure', async () => {
    await expect(store.importExternalSession(input(''))).rejects.toThrow();
    expect(await store.listSessions(7, { archived: null })).toHaveLength(0);
    expect(
      await store.findImportedSession(7, 'codex', 'external-1'),
    ).toBeNull();
  });
});

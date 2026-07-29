import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { createCoderRuntime } from '../state.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'coder-state-recovery-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = openStore();
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('coder filesystem interaction recovery', () => {
  it('recovers an interactive tool call and its input after reopening', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Pending decision',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'pending-decision',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'decision-1',
          name: 'decision_gate',
          input: {
            questions: [{
              id: 'storage',
              question: 'Which storage?',
              options: [{ label: 'Filesystem', value: 'filesystem' }],
            }],
          },
        }],
      },
    });

    await store.close();
    store = openStore();
    const runtime = createCoderRuntime(store);

    await expect(runtime.findPendingInteraction(session.id)).resolves.toEqual({
      toolUseId: 'decision-1',
      name: 'decision_gate',
      input: expect.objectContaining({
        questions: expect.any(Array),
      }),
    });

    await store.appendMessage({
      session_id: session.id,
      operation_id: 'pending-decision-result',
      message: {
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'decision-1',
          content: 'Filesystem',
        }],
      },
    });
    await expect(runtime.findPendingInteraction(session.id)).resolves.toBeNull();
  });

  it('recovers a specific non-interactive dangling tool approval', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Pending approval',
      provider: 'test',
      model: 'test',
    });
    await store.appendMessage({
      session_id: session.id,
      operation_id: 'pending-write',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'write-1',
          name: 'write_file',
          input: { path: 'src/file.ts' },
        }],
      },
    });

    await store.close();
    store = openStore();
    const runtime = createCoderRuntime(store);

    await expect(
      runtime.findDanglingToolUse(session.id, 'write-1'),
    ).resolves.toEqual({
      toolUseId: 'write-1',
      name: 'write_file',
    });
    await expect(runtime.findPendingInteraction(session.id)).resolves.toBeNull();
  });
});

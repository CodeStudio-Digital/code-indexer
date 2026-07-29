import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionId } from '@mcp/session-storage';
import { FsSessionStore } from '../fs-session-store.js';
import { readFsSessionMemoryKpis } from '../memory-kpis.js';

let temporaryRoot: string;
let dataDir: string;
let firstRoot: string;
let secondRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-memory-kpis-'));
  dataDir = join(temporaryRoot, 'data');
  firstRoot = join(temporaryRoot, 'first');
  secondRoot = join(temporaryRoot, 'second');
  await Promise.all([
    mkdir(dataDir),
    mkdir(firstRoot),
    mkdir(secondRoot),
  ]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 1
          ? firstRoot
          : projectId === 2
            ? secondRoot
            : null,
      listProjectRoots: () => [
        { project_id: 1, root_path: firstRoot },
        { project_id: 2, root_path: secondRoot },
      ],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function recordLearning(
  sessionId: SessionId,
  projectId: number,
  toolName: 'recall_memory' | 'remember' | 'forget_memory',
  suffix: string,
): Promise<void> {
  await store.appendSessionEvent(
    sessionId,
    'memory_distill',
    { projectId, created: 1, merged: 0 },
    `memory-distill-${suffix}`,
  );
  const toolUseId = `memory-tool-${suffix}`;
  await store.persistAssistantTurn({
    session_id: sessionId,
    operation_id: `assistant-${suffix}`,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: {},
      }],
    },
    usage: null,
    tool_calls: [{
      tool_use_id: toolUseId,
      tool_name: toolName,
      args: {},
      result_text: 'ok',
      is_error: false,
      duration_ms: 1,
    }],
  });
}

describe('filesystem Agent Memory KPI projection', () => {
  it('counts owning and linked sessions from bundle events and tool records', async () => {
    const projectSession = await store.createSession({
      project_id: 1,
      title: 'Project one',
      provider: 'test',
      model: 'test',
    });
    const globalSession = await store.createGlobalSession({
      title: 'Shared workspace',
      provider: 'test',
      model: 'test',
      owner_project_id: 1,
      realProjects: [
        { projectId: 1, rootPath: firstRoot, isPrimary: true },
        { projectId: 2, rootPath: secondRoot },
      ],
    });

    await recordLearning(projectSession.id, 1, 'remember', 'project-one');
    await recordLearning(globalSession.id, 1, 'recall_memory', 'global-one');
    await store.appendSessionEvent(
      globalSession.id,
      'memory_distill',
      { project_id: 2, created: 0, merged: 2 },
      'memory-distill-global-two',
    );

    const now = Date.now() + 1_000;
    await expect(
      readFsSessionMemoryKpis(store, 1, { now, windowDays: 30 }),
    ).resolves.toEqual({
      windowDays: 30,
      sessionsInWindow: 2,
      learnedSessions: 2,
      explicitCalls: {
        remember: 1,
        recall_memory: 1,
      },
    });
    await expect(
      readFsSessionMemoryKpis(store, 2, { now, windowDays: 30 }),
    ).resolves.toEqual({
      windowDays: 30,
      sessionsInWindow: 1,
      learnedSessions: 1,
      explicitCalls: {
        recall_memory: 1,
      },
    });
  });
});

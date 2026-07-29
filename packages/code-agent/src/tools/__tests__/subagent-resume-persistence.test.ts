import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../../sessions/fs-store/fs-session-store.js';
import type { SessionId } from '@mcp/session-storage';
import {
  clearSession,
  getGroup,
  retainGroup,
  type ResumableGroup,
} from '../subagent-resume-registry.js';

let temporaryRoot: string;
let projectRoot: string;
let dataDir: string;
let sessionId: SessionId;
let store: FsSessionStore;

function openStore(): FsSessionStore {
  return FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 91 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 91, root_path: projectRoot },
      ],
    },
  });
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'resume-checkpoint-'));
  projectRoot = join(temporaryRoot, 'project');
  dataDir = join(temporaryRoot, 'data');
  await Promise.all([mkdir(projectRoot), mkdir(dataDir)]);
  store = openStore();
  sessionId = (
    await store.createSession({
      project_id: 91,
      title: 'resume checkpoint',
      provider: 'fake',
      model: 'fake-model',
    })
  ).id;
});

afterEach(async () => {
  await clearSession(sessionId);
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('subagent resume filesystem checkpoint', () => {
  it('restores a redacted failed transcript after memory/store recreation', async () => {
    const now = Date.now();
    const group: ResumableGroup = {
      spawnId: 'spawn-restart',
      sessionId,
      provider: 'fake',
      model: 'fake-model',
      createdAt: now,
      lastTouchedAt: now,
      agents: [{
        agentIndex: 0,
        label: 'recover',
        task: 'Continue with api_key=TOP_SECRET_VALUE '
          + 'AKIA1234567890ABCDEF xoxb-1234567890-ABCDEFGHIJ '
          + 'DATABASE_PASSWORD=database-super-secret '
          + 'Qm9ndXNPcGFxdWVTZWNyZXQxMjM0NTY3ODkw',
        profileId: 'explore',
        maxTurns: 10,
        limits: { maxToolCalls: 20 },
        transcript: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Bearer TOP_SECRET_VALUE' }],
          },
          {
            role: 'assistant',
            content: [{ type: 'thinking', text: 'private reasoning' }],
          },
        ],
        reason: 'error',
        failureNote: 'password=TOP_SECRET_VALUE',
        toolCallCount: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        attempt: 1,
        capturedAt: now,
        approxBytes: 0,
      }],
    };

    await retainGroup(sessionId, group, store);
    const [checkpoint] = await store.listOrchestrationCheckpoints(
      sessionId,
      'subagent_resume',
    );
    expect(checkpoint.scope_id).toBe('spawn-restart');
    expect(checkpoint.payload_json).not.toContain('TOP_SECRET_VALUE');
    expect(checkpoint.payload_json).not.toContain('private reasoning');
    expect(checkpoint.payload_json).not.toContain('AKIA1234567890ABCDEF');
    expect(checkpoint.payload_json).not.toContain('xoxb-1234567890-ABCDEFGHIJ');
    expect(checkpoint.payload_json).not.toContain('database-super-secret');
    expect(checkpoint.payload_json).not.toContain(
      'Qm9ndXNPcGFxdWVTZWNyZXQxMjM0NTY3ODkw',
    );

    await clearSession(sessionId);
    await store.close();
    store = openStore();
    const restored = await getGroup(
      sessionId,
      'spawn-restart',
      store,
    );
    expect(restored?.agents[0].reason).toBe('error');
    expect(restored?.agents[0].transcript?.length).toBeGreaterThan(0);
    expect(JSON.stringify(restored)).not.toContain('TOP_SECRET_VALUE');
  });
});

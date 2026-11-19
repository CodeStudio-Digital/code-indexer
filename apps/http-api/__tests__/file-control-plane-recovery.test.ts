import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { CONTROL_PLANE_SCHEMA_VERSION, asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId, type SessionCommand, type SessionId } from '@mcp/agent-runtime-contracts';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { SessionRecoveryError } from '../control-plane-recovery-error.js';

let root: string;
let sessions: FsSessionStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-recovery-isolation-'));
  const project = join(root, 'project');
  await mkdir(project);
  sessions = FsSessionStore.fromRoots({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project,
    listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await sessions.close();
  await rm(root, { recursive: true, force: true });
});
function command(sessionId: SessionId): SessionCommand<Record<string, unknown>> {
  return { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, commandId: asSessionCommandId(randomUUID()),
    sessionId, kind: 'send_message', idempotencyKey: randomUUID(), requestedAt: new Date().toISOString(),
    actor: { actorId: 'test', actorType: 'user', source: 'http' }, correlationId: asCorrelationId(randomUUID()), payload: { task: 'test' } };
}
async function start(authority: FileControlPlaneStore, id?: SessionId) {
  const sessionId = id ?? (await sessions.createSession({ project_id: 1, title: 'Recovery fixture', provider: 'test', model: 'test' })).id;
  const request = command(sessionId);
  const agentRunId = asAgentRunId(randomUUID());
  const attemptId = asAgentRunAttemptId(randomUUID());
  await authority.acceptCommand({ command: request, payloadHash: hashControlPlanePayload(request.payload), run: {
    agentRunId, attemptId, role: 'build', agentDefinitionId: 'build', waitMode: 'foreground',
    requestedCapabilityProfile: 'full', executorOwnerId: 'fixture', executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } });
  return { sessionId, command: request, agentRunId, attemptId };
}

describe('restart recovery isolation', () => {
  it('quarantines an unreadable session, admits healthy sessions and retries only the repaired session', async () => {
    const before = new FileControlPlaneStore(sessions);
    const healthy = await start(before);
    const damaged = await start(before);
    const location = await sessions.getSessionLocation(damaged.sessionId);
    let unavailable = true;
    const list = ControlPlaneFileRepository.prototype.list;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'list').mockImplementation(function (this: ControlPlaneFileRepository, kind, options) {
      if (unavailable && kind === 'run' && this.sessionRoot === location!.bundle_path) {
        return Promise.reject(Object.assign(new Error('UNKNOWN: scandir events/runs'), { code: 'UNKNOWN' }));
      }
      return list.call(this, kind, options);
    });
    const restarted = new FileControlPlaneStore(sessions);
    expect(await restarted.recoverInterruptedRuns()).toBe(1);
    const live = await start(restarted, healthy.sessionId);
    expect(await restarted.getRun(healthy.sessionId, healthy.agentRunId)).toMatchObject({ status: 'interrupted' });
    const blocked = command(damaged.sessionId);
    await expect(restarted.acceptCommand({ command: blocked, payloadHash: hashControlPlanePayload(blocked.payload) })).rejects.toBeInstanceOf(SessionRecoveryError);
    expect(await restarted.getCommand(damaged.sessionId, blocked.commandId)).toBeNull();
    unavailable = false;
    expect((await restarted.acceptCommand({ command: blocked, payloadHash: hashControlPlanePayload(blocked.payload) })).kind).toBe('accepted');
    expect(await restarted.getRun(damaged.sessionId, damaged.agentRunId)).toMatchObject({ status: 'interrupted' });
    expect(await restarted.getRun(live.sessionId, live.agentRunId)).toMatchObject({ status: 'starting' });
  });

  it('retries a failed catalog initialization instead of permanently caching rejection', async () => {
    const before = new FileControlPlaneStore(sessions);
    const old = await start(before);
    vi.spyOn(sessions, 'ensureCatalog').mockRejectedValueOnce(new Error('temporary catalog I/O failure'));
    const restarted = new FileControlPlaneStore(sessions);
    await expect(restarted.recoverInterruptedRuns()).rejects.toThrow('temporary catalog');
    const fresh = await start(restarted, old.sessionId);
    expect(await restarted.getRun(old.sessionId, old.agentRunId)).toMatchObject({ status: 'interrupted' });
    expect(await restarted.getRun(fresh.sessionId, fresh.agentRunId)).toMatchObject({ status: 'starting' });
  });

  it('finishes partial recovery after a command write fails, before admitting new work', async () => {
    const before = new FileControlPlaneStore(sessions);
    const old = await start(before);
    const update = ControlPlaneFileRepository.prototype.update;
    let unavailable = true;
    vi.spyOn(ControlPlaneFileRepository.prototype, 'update').mockImplementation(function (this: ControlPlaneFileRepository, kind, id, input) {
      if (kind === 'command' && unavailable) return Promise.reject(new Error('temporary command write failure'));
      return update.call(this, kind, id, input);
    });
    const restarted = new FileControlPlaneStore(sessions);
    expect(await restarted.recoverInterruptedRuns()).toBe(0);
    const next = command(old.sessionId);
    await expect(restarted.acceptCommand({ command: next, payloadHash: hashControlPlanePayload(next.payload) })).rejects.toBeInstanceOf(SessionRecoveryError);
    unavailable = false;
    expect((await restarted.acceptCommand({ command: next, payloadHash: hashControlPlanePayload(next.payload) })).kind).toBe('accepted');
    expect(await restarted.getRun(old.sessionId, old.agentRunId)).toMatchObject({ status: 'interrupted' });
    expect(await restarted.getCommand(old.sessionId, old.command.commandId)).toMatchObject({ status: 'failed', reasonCode: 'process-restart' });
  });
});

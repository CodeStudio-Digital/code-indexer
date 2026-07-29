import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  asAgentRunAttemptId,
  asAgentRunId,
  asCorrelationId,
  asSessionCommandId,
  type SessionCommand,
} from '@mcp/agent-runtime-contracts';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let sessions: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-file-control-plane-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : undefined,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
    projectInfoResolver: (projectId) =>
      projectId === 7
        ? {
            project_id: 7,
            name: 'Control plane fixture',
            root_path: projectRoot,
          }
        : null,
  });
});

afterEach(async () => {
  await sessions.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

function commandFor(
  sessionId: Awaited<ReturnType<FsSessionStore['createSession']>>['id'],
  key: string,
): SessionCommand<Record<string, unknown>> {
  return {
    schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    commandId: asSessionCommandId(randomUUID()),
    idempotencyKey: key,
    kind: 'send_message',
    sessionId,
    actor: {
      actorId: 'fixture-user',
      actorType: 'user',
      source: 'http',
    },
    requestedAt: new Date().toISOString(),
    correlationId: asCorrelationId(randomUUID()),
    payload: { promptHash: 'fixture' },
  };
}

describe('FileControlPlaneStore', () => {
  it('persists idempotent command/run/attempt authority inside the session bundle', async () => {
    const session = await sessions.createSession({
      project_id: 7,
      title: 'Filesystem authority',
      provider: 'openai',
      model: 'gpt-test',
    });
    const authority = new FileControlPlaneStore(sessions, {
      journalEnabled: true,
    });
    const command = commandFor(session.id, 'client-key');
    const agentRunId = asAgentRunId(randomUUID());
    const attemptId = asAgentRunAttemptId(randomUUID());
    const executorOwnerId = `coder-worker:${session.id}:${agentRunId}`;
    const accepted = await authority.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      run: {
        agentRunId,
        attemptId,
        role: 'build',
        agentDefinitionId: 'build',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'full',
        executorOwnerId,
        executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted' || !accepted.agentRun || !accepted.attempt) {
      throw new Error('expected accepted command with a run');
    }

    const replay = await authority.acceptCommand({
      command: { ...command, commandId: asSessionCommandId(randomUUID()) },
      payloadHash: hashControlPlanePayload(command.payload),
    });
    expect(replay.kind).toBe('existing');
    if (replay.kind !== 'existing') throw new Error('expected replay');
    expect(replay.command.commandId).toBe(command.commandId);

    const context = {
      sessionId: session.id,
      commandId: command.commandId,
      correlationId: command.correlationId,
      actor: command.actor,
      agentRunId,
      attemptId,
      executorOwnerId,
      fencingEpoch: 1,
    };
    await authority.bindCommandExecution(
      context,
      `bus:${randomUUID()}`,
    );
    await authority.markRunStarted(context, `runner:${randomUUID()}`);
    const heartbeatAt = new Date().toISOString();
    await authority.renewAttemptLease(
      context,
      new Date(Date.now() + 600_000).toISOString(),
      heartbeatAt,
    );
    await authority.terminalizeRun({
      context,
      status: 'completed',
      commandStatus: 'succeeded',
      reason: 'completed',
      attemptLeaseStatus: 'released',
    });

    expect(await authority.getCommand(session.id, command.commandId)).toMatchObject({
      status: 'succeeded',
      reasonCode: 'completed',
      agentRunId,
    });
    expect(await authority.getRun(session.id, agentRunId)).toMatchObject({
      status: 'completed',
      terminalReason: 'completed',
    });

    const location = await sessions.getSessionLocation(session.id);
    if (!location) throw new Error('session bundle disappeared');
    expect(
      await readdir(join(location.bundle_path, 'events', 'commands')),
    ).toEqual(expect.arrayContaining([`${command.commandId}.json`]));
    expect(
      await readdir(join(location.bundle_path, 'events', 'runs')),
    ).toEqual(expect.arrayContaining([`${agentRunId}.json`]));
    expect(
      await readdir(join(location.bundle_path, 'events', 'attempts')),
    ).toEqual(expect.arrayContaining([`${attemptId}.json`]));
  });

  it('recovers a non-terminal run as interrupted without consulting SQLite', async () => {
    const session = await sessions.createSession({
      project_id: 7,
      title: 'Recovery',
      provider: 'anthropic',
      model: 'claude-test',
    });
    const authority = new FileControlPlaneStore(sessions);
    const command = commandFor(session.id, 'recovery-key');
    const agentRunId = asAgentRunId(randomUUID());
    const attemptId = asAgentRunAttemptId(randomUUID());
    const executorOwnerId = `coder-worker:${session.id}:${agentRunId}`;
    const accepted = await authority.acceptCommand({
      command,
      payloadHash: hashControlPlanePayload(command.payload),
      run: {
        agentRunId,
        attemptId,
        role: 'explore',
        agentDefinitionId: 'explore',
        waitMode: 'foreground',
        requestedCapabilityProfile: 'navigate',
        executorOwnerId,
        executorExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    if (
      accepted.kind !== 'accepted' ||
      !accepted.agentRun ||
      !accepted.attempt
    ) {
      throw new Error('expected accepted command with a run');
    }
    const context = {
      sessionId: session.id,
      commandId: command.commandId,
      correlationId: command.correlationId,
      actor: command.actor,
      agentRunId,
      attemptId,
      executorOwnerId,
      fencingEpoch: 1,
    };
    await authority.markRunStarted(context, 'runner-before-crash');

    const restarted = new FileControlPlaneStore(sessions);
    expect(await restarted.recoverInterruptedRuns()).toBe(1);
    expect(await restarted.getRun(session.id, agentRunId)).toMatchObject({
      status: 'interrupted',
      terminalReason: 'process-restart',
    });
    expect(
      await restarted.getCommand(session.id, command.commandId),
    ).toMatchObject({
      status: 'failed',
      reasonCode: 'process-restart',
    });
  });
});

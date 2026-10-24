import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentV1Common, asAgentRunAttemptId, asAgentRunId, asCorrelationId, asSessionCommandId,
  type SessionCommand } from '@mcp/agent-runtime-contracts';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { hashControlPlanePayload } from '@mcp/store/control-plane/index.js';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { FileControlPlaneStore } from '../file-control-plane-store.js';

export async function supervisorFactFixture(role = 'build', executorLeaseMs = 600_000) {
  const directory = await mkdtemp(join(tmpdir(), 'codestudio-supervisor-facts-'));
  const dataDir = join(directory, 'data');
  const projectRoot = join(directory, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  const sessions = FsSessionStore.fromRoots({ dataDir, projectRootResolver: {
    resolveProjectRoot: () => projectRoot, listProjectRoots: () => [{ project_id: 1, root_path: projectRoot }],
  } });
  const session = await sessions.createSession({ project_id: 1, provider: 'openai', model: 'fixture', title: 'Supervisor facts' });
  const store = new FileControlPlaneStore(sessions);
  const command: SessionCommand = { schemaVersion: 1, commandId: asSessionCommandId(randomUUID()),
    sessionId: session.id, correlationId: asCorrelationId(randomUUID()), requestedAt: new Date().toISOString(),
    actor: { actorId: 'fixture', actorType: 'user', source: 'http' }, kind: 'send_message',
    idempotencyKey: randomUUID(), payload: {} };
  const context = { sessionId: session.id, commandId: command.commandId, correlationId: command.correlationId,
    actor: command.actor, agentRunId: asAgentRunId(randomUUID()), attemptId: asAgentRunAttemptId(randomUUID()),
    executorOwnerId: `host:${randomUUID()}`, fencingEpoch: 1 };
  await store.acceptCommand({ command, payloadHash: hashControlPlanePayload(command.payload), run: {
    ...context, role, agentDefinitionId: role, waitMode: 'foreground', requestedCapabilityProfile: 'full',
    executorExpiresAt: new Date(Date.now() + executorLeaseMs).toISOString(),
  } });
  const identity = create(agentV1Common.AttemptIdentitySchema, {
    ...context, fencingEpoch: 1n, rootAgentRunId: context.agentRunId,
  });
  const entry = sessions.catalog.get(session.id)!;
  const repository = new ControlPlaneFileRepository({ sessionRoot: entry.location.bundle_path });
  return { directory, sessions, store, context, identity, repository };
}

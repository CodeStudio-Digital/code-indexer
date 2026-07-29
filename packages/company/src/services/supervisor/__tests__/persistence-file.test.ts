import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSupervisionRecord } from '../heartbeat-tracker.js';
import { FileSupervisionPersistence } from '../persistence-file.js';

const temporaryRoots: string[] = [];

async function createPersistence(): Promise<{
  companySessionId: string;
  root: string;
  persistence: FileSupervisionPersistence;
}> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-company-supervisor-'));
  temporaryRoots.push(root);
  const companySessionId = randomUUID();
  return {
    companySessionId,
    root,
    persistence: new FileSupervisionPersistence({
      companySessionId,
      sessionRoot: root,
    }),
  };
}

function record(
  companySessionId: string,
  agentRunId: string = randomUUID(),
): AgentSupervisionRecord {
  return {
    agentRunId,
    companySessionId,
    role: 'frontend',
    state: 'RUNNING_TURN',
    enteredAt: 100,
    lastHeartbeatAt: 200,
    currentToolUseId: null,
    currentToolName: null,
    stateTimeoutMsOverride: null,
    recoveryAttempts: 0,
    incidentCount: 0,
  };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('FileSupervisionPersistence', () => {
  it('persists each agent record in its own bundle file and rehydrates it', async () => {
    const harness = await createPersistence();
    const first = record(harness.companySessionId);
    const second = record(harness.companySessionId);

    await harness.persistence.saveRecord(first);
    await harness.persistence.saveRecord(second);
    await harness.persistence.close();

    const files = await readdir(
      join(harness.root, 'company', 'supervision', 'records'),
    );
    expect(files.sort()).toEqual(
      [`${first.agentRunId}.json`, `${second.agentRunId}.json`].sort(),
    );

    const reopened = new FileSupervisionPersistence({
      companySessionId: harness.companySessionId,
      sessionRoot: harness.root,
    });
    expect(
      reopened
        .loadAll()
        .sort((left, right) => left.agentRunId.localeCompare(right.agentRunId)),
    ).toEqual(
      [first, second].sort((left, right) =>
        left.agentRunId.localeCompare(right.agentRunId),
      ),
    );
  });

  it('atomically flushes heartbeats without rewriting another agent file', async () => {
    const harness = await createPersistence();
    const first = record(harness.companySessionId);
    const second = record(harness.companySessionId);
    await harness.persistence.saveRecord(first);
    await harness.persistence.saveRecord(second);

    await harness.persistence.saveHeartbeats([
      { agentRunId: first.agentRunId, lastHeartbeatAt: 999 },
    ]);

    const rows = harness.persistence.loadAll();
    expect(
      rows.find((candidate) => candidate.agentRunId === first.agentRunId)
        ?.lastHeartbeatAt,
    ).toBe(999);
    expect(
      rows.find((candidate) => candidate.agentRunId === second.agentRunId)
        ?.lastHeartbeatAt,
    ).toBe(200);
  });

  it('stores, orders and resolves independent incident files', async () => {
    const harness = await createPersistence();
    const agentRunId = randomUUID();
    await harness.persistence.saveIncident({
      agentRunId,
      companySessionId: harness.companySessionId,
      incidentKind: 'stuck_detected',
      fromState: 'AWAITING_TOOL',
      attemptedToState: 'STUCK_TOOL',
      detail: 'tool stalled',
      detectedAtMs: 1_000,
    });
    await harness.persistence.saveIncident({
      agentRunId: null,
      companySessionId: harness.companySessionId,
      incidentKind: 'read_only_mode',
      fromState: null,
      attemptedToState: null,
      detail: 'breaker opened',
      detectedAtMs: 2_000,
    });

    const incidents = harness.persistence.listRecentIncidents(
      harness.companySessionId,
      10,
    );
    expect(incidents.map((incident) => incident.detail)).toEqual([
      'breaker opened',
      'tool stalled',
    ]);
    expect(incidents[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await harness.persistence.resolveIncident(incidents[0].id, 3_000);
    expect(
      harness.persistence.listRecentIncidents(
        harness.companySessionId,
        10,
      )[0].resolvedAtMs,
    ).toBe(3_000);
  });

  it('fails closed when a record belongs to another Company session', async () => {
    const harness = await createPersistence();
    await expect(
      harness.persistence.saveRecord(record(randomUUID())),
    ).rejects.toThrow('expected');
  });
});

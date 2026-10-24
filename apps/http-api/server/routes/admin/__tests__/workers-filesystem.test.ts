import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import {
  readAgentRunShadowMetrics,
  readJournalStorageByRun,
  readPolicyDivergences,
} from '../workers.js';

let temporaryRoot: string;
let projectRoot: string;
let dataDir: string;
let sessions: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-worker-diagnostics-'));
  projectRoot = join(temporaryRoot, 'project');
  dataDir = join(temporaryRoot, 'data');
  await Promise.all([mkdir(projectRoot), mkdir(dataDir)]);
  sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 11 ? projectRoot : undefined,
      listProjectRoots: () => [
        { project_id: 11, root_path: projectRoot },
      ],
    },
  });
});

afterEach(async () => {
  await sessions.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('filesystem worker diagnostics', () => {
  it('aggregates journal, child runs and policy comparisons from bundles', async () => {
    const session = await sessions.createSession({
      project_id: 11,
      title: 'Diagnostics',
      provider: 'openai',
      model: 'gpt-test',
    });
    const location = await sessions.getSessionLocation(session.id);
    if (!location) throw new Error('session bundle was not created');
    const repository = new ControlPlaneFileRepository({
      sessionRoot: location.bundle_path,
    });
    const parentRunId = randomUUID();
    const childRunId = randomUUID();

    await repository.createRun({
      id: parentRunId,
      relations: { session: session.id },
      data: {
        status: 'running',
        run: {
          agentRunId: parentRunId,
          sessionId: session.id,
          status: 'running',
        },
      },
    });
    await repository.createRun({
      id: childRunId,
      relations: {
        session: session.id,
        parent: parentRunId,
      },
      data: {
        status: 'completed',
        run: {
          agentRunId: childRunId,
          sessionId: session.id,
          parentAgentRunId: parentRunId,
          status: 'completed',
        },
      },
    });
    await repository.appendEvent({
      id: randomUUID(),
      relations: {
        session: session.id,
        run: childRunId,
      },
      data: {
        eventType: 'tool.completed',
        payload: { result: 'persisted in the bundle' },
      },
    });
    await repository.appendEvent({
      id: randomUUID(),
      relations: {
        session: session.id,
        run: childRunId,
      },
      data: {
        eventType: 'control-plane.divergence',
        payload: { kind: 'agent_run_shadow_write_error' },
      },
    });

    const comparedAt = new Date().toISOString();
    await repository.recordPolicyDecision({
      id: randomUUID(),
      relations: { session: session.id },
      data: {
        effect: 'allow',
        reasonCode: 'agreement',
        recordType: 'comparison',
        comparisonId: 'comparison:agreement',
        capabilityId: 'tool:read',
        legacyEffect: 'allow',
        shadowEffect: 'allow',
        agreement: true,
        comparedAt,
        evaluationMs: 5,
      },
    });
    await repository.recordPolicyDecision({
      id: randomUUID(),
      relations: { session: session.id },
      data: {
        effect: 'deny',
        reasonCode: 'effect_mismatch',
        recordType: 'comparison',
        comparisonId: 'comparison:divergence',
        capabilityId: 'tool:write',
        legacyEffect: 'allow',
        shadowEffect: 'deny',
        agreement: false,
        divergenceKind: 'effect_mismatch',
        critical: true,
        detail: 'shadow denied a legacy allow',
        comparedAt,
        evaluationMs: 20,
      },
    });

    await expect(readJournalStorageByRun(sessions)).resolves.toMatchObject({
      available: true,
      events: 2,
      runs: [
        {
          agentRunId: childRunId,
          events: 2,
        },
      ],
    });
    await expect(readAgentRunShadowMetrics(sessions)).resolves.toEqual({
      available: true,
      childRunsCreated: 1,
      childRunsTerminalized: 1,
      activeChildRuns: 0,
      writeErrors: 1,
    });
    await expect(readPolicyDivergences(sessions, 10)).resolves.toMatchObject({
      available: true,
      total: 2,
      agreements: 1,
      agreementRate: 0.5,
      criticalDivergences: 1,
      evaluationOverhead: {
        p50: 5,
        p95: 20,
        p99: 20,
        samples: 2,
      },
      divergences: [
        {
          comparisonId: 'comparison:divergence',
          capabilityId: 'tool:write',
          critical: 1,
        },
      ],
    });
  });
});

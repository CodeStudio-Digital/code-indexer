/**
 * Policy shadow burn-in smoke — functional, not an efficacy claim.
 *
 * Drives allow/deny/external invocations against a real filesystem session
 * bundle and proves that policy data is durable without SQLite or raw input.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlPlaneFileRepository,
  isUuid,
} from '@mcp/session-storage';
import {
  FsPolicyShadowRepository,
  FsSessionStore,
} from '@mcp/code-agent/sessions/fs-store/index.js';
import { ToolRegistry } from '../registry.js';
import type { CoderTool } from '../tool.js';
import { createPolicyShadowPort } from '../policy-shadow-adapter.js';

const FLAGS = [
  'CODER_POLICY_ENGINE_SHADOW',
  'CODER_CAPABILITY_CATALOG_SHADOW',
  'CODER_HOOK_BUS_V1',
  'CODER_RESOURCE_GRANTS',
  'CODER_POLICY_ENGINE_ENFORCE',
] as const;
const SENTINEL = 'SECRET-BURNIN-INPUT-VALUE';

let previous: Record<string, string | undefined>;
let temporaryRoot: string;
let sessions: FsSessionStore;

function tool(
  overrides: Partial<CoderTool> & {
    name: string;
    source: CoderTool['source'];
  },
): CoderTool {
  return {
    description: 'burn-in tool',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ content: 'ok' }) as never,
    ...overrides,
  } as CoderTool;
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'policy-shadow-fs-'));
  const projectRoot = join(temporaryRoot, 'project');
  const dataDir = join(temporaryRoot, 'data');
  await Promise.all([mkdir(projectRoot), mkdir(dataDir)]);
  sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 17 ? projectRoot : undefined,
      listProjectRoots: () => [
        { project_id: 17, root_path: projectRoot },
      ],
    },
  });
  previous = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
  for (const flag of FLAGS) delete process.env[flag];
  process.env.CODER_POLICY_ENGINE_SHADOW = '1';
  process.env.CODER_CAPABILITY_CATALOG_SHADOW = '1';
});

afterEach(async () => {
  await sessions.close();
  await rm(temporaryRoot, { recursive: true, force: true });
  for (const flag of FLAGS) {
    if (previous[flag] === undefined) delete process.env[flag];
    else process.env[flag] = previous[flag];
  }
});

describe('policy shadow filesystem burn-in', () => {
  it('rejects a comparison whose decision file was not committed', async () => {
    const session = await sessions.createSession({
      project_id: 17,
      title: 'Missing policy decision',
      provider: 'openai',
      model: 'gpt-test',
    });
    const persistence = new FsPolicyShadowRepository(sessions);

    await expect(
      persistence.recordComparison({
        sessionId: session.id,
        agentRunId: randomUUID(),
        comparisonId: 'comparison:missing',
        decisionId: 'decision:missing',
        capabilityId: 'cap:native:read_file',
        toolUseId: 'tool-use-missing',
        legacyEffect: 'allow',
        shadowEffect: 'allow',
        comparedAt: new Date().toISOString(),
        evaluationMs: 0,
      }),
    ).rejects.toThrow('references missing decision');
  });

  it('persists UUID records, comparisons and one capability checkpoint without raw input', async () => {
    const session = await sessions.createSession({
      project_id: 17,
      title: 'Policy shadow',
      provider: 'openai',
      model: 'gpt-test',
    });
    const registry = new ToolRegistry();
    const readTool = tool({
      name: 'read_file',
      source: 'native',
      mutates: false,
      riskLevel: 'read',
    });
    const editTool = tool({
      name: 'edit_file',
      source: 'native',
      mutates: true,
      riskLevel: 'write',
    });
    const externalTool = tool({
      name: 'mcp__mail__send',
      source: 'mcp_external',
    });
    registry.registerAll([readTool, editTool, externalTool]);

    const created = createPolicyShadowPort({
      persistence: new FsPolicyShadowRepository(sessions),
      registry,
      sessionContext: {
        getLegacyContext: () => ({
          planMode: true,
          planApproved: false,
          taskScope: null,
        }),
        background: false,
        sessionId: session.id,
      },
      log: () => undefined,
    });
    if (!created) throw new Error('policy shadow flags were not applied');

    for (const [index, entry] of [
      { tool: readTool, name: 'read_file' },
      { tool: editTool, name: 'edit_file' },
      { tool: externalTool, name: 'mcp__mail__send' },
    ].entries()) {
      await expect(
        created.port({
          tool: entry.tool,
          toolUseId: `tool-use-${index}`,
          toolName: entry.name,
          toolInput: { note: SENTINEL, index },
          turn: 1,
        }),
      ).resolves.toEqual({ refuse: false });
    }

    const location = await sessions.getSessionLocation(session.id);
    if (!location) throw new Error('session bundle was not created');
    const repository = new ControlPlaneFileRepository({
      sessionRoot: location.bundle_path,
    });
    const policyRecords = (
      await repository.list('policyDecision', {
        limit: 100,
        order: 'asc',
      })
    ).items;
    const decisions = policyRecords.filter(
      (record) => record.data.recordType === 'decision',
    );
    const comparisons = policyRecords.filter(
      (record) => record.data.recordType === 'comparison',
    );
    const checkpoints = (
      await repository.list('checkpoint', {
        limit: 100,
        order: 'asc',
      })
    ).items.filter(
      (record) =>
        record.data.checkpointType === 'resolved_capability_set',
    );

    expect(decisions).toHaveLength(3);
    expect(comparisons).toHaveLength(3);
    expect(checkpoints).toHaveLength(1);
    expect(
      [...policyRecords, ...checkpoints].every(
        (record) =>
          isUuid(record.id) &&
          isUuid(record.operationId) &&
          record.relations.session === session.id,
      ),
    ).toBe(true);

    const comparisonData = comparisons.map((record) => record.data);
    expect(
      comparisonData.filter((data) => data.agreement === true),
    ).toHaveLength(3);
    expect(
      comparisonData.find((data) => data.shadowEffect === 'deny'),
    ).toMatchObject({
      legacyEffect: 'block',
      agreement: true,
    });
    for (const data of comparisonData) {
      expect(data.evaluationMs).toEqual(expect.any(Number));
      expect(data.evaluationMs as number).toBeGreaterThanOrEqual(0);
    }

    expect(checkpoints[0].data.descriptors).toHaveLength(3);
    expect(JSON.stringify([...policyRecords, ...checkpoints])).not.toContain(
      SENTINEL,
    );
  });
});

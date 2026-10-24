import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { FsTurnTelemetryRepository } from '@mcp/session-storage/fs-store/turn-telemetry.js';
import type { ServerDeps } from '../../deps.js';
import { mountTelemetryRoutes } from '../telemetry.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_CONTROL_PLANE_CHECKPOINT_ID =
  '22222222-2222-4222-8222-222222222222';

let root: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-telemetry-route-'));
  dataDir = join(root, 'data');
  projectRoot = join(root, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => (id === 7 ? projectRoot : null),
      listProjectRoots: () => [{ project_id: 7, root_path: projectRoot }],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe('filesystem telemetry routes', () => {
  it('reads immutable UUID-scoped metrics without a SQLite session store', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Telemetry',
      provider: 'test',
      model: 'model',
    });
    await new FsTurnTelemetryRepository(store).recordTurnTelemetry({
      session_id: session.id,
      run_id: RUN_ID,
      turn: 1,
      is_subagent: false,
      provider: 'test',
      model: 'model',
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 0,
      thinking_tokens: null,
      history_chars: 500,
      tool_count: 1,
      tools_called: ['read_file'],
      largest_tool_result_chars: 50,
      compaction_triggered: false,
      summarizer_ran: false,
      paginate_count: 0,
    });
    const location = await store.getSessionLocation(session.id);
    if (!location) throw new Error('session location missing');
    await writeFile(
      join(
        location.bundle_path,
        'checkpoints',
        `${LEGACY_CONTROL_PLANE_CHECKPOINT_ID}.json`,
      ),
      JSON.stringify({
        schemaVersion: 1,
        id: LEGACY_CONTROL_PLANE_CHECKPOINT_ID,
        seq: 1,
        kind: 'control-plane.checkpoint',
        operationId: LEGACY_CONTROL_PLANE_CHECKPOINT_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        relations: { session: session.id },
        data: {
          checkpointType: 'resolved_capability_set',
          sessionId: session.id,
        },
      }),
      'utf8',
    );

    const app = new Hono();
    mountTelemetryRoutes(app, {
      sessionStore: store,
      providerStore: {},
    } as unknown as ServerDeps);

    const response = await app.request(`/api/sessions/${session.id}/telemetry`);
    const payload = (await response.json()) as {
      turn_count: number;
      turns: Array<{ run_id: string; tools_called_json: string }>;
      attempts: unknown[];
    };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      turn_count: 0,
      attempts: [],
    });
    expect(payload.turns).toEqual([
      expect.objectContaining({
        run_id: RUN_ID,
        tools_called_json: '["read_file"]',
      }),
    ]);
    await expect(store.listCompactionAttempts(session.id)).resolves.toEqual([]);
  });

  it('rejects legacy numeric session ids', async () => {
    const app = new Hono();
    mountTelemetryRoutes(app, {
      sessionStore: store,
      providerStore: {},
    } as unknown as ServerDeps);

    expect((await app.request('/api/sessions/1221/telemetry')).status).toBe(400);
  });
});

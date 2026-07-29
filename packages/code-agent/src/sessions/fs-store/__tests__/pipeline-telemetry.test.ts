import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TelemetryEvent } from '@mcp/candidate-pipeline/stats.js';
import { FsSessionStore } from '../fs-session-store.js';
import { FsPipelineTelemetrySink } from '../pipeline-telemetry.js';

let temporaryRoot: string;
let dataDir: string;
let projectRoot: string;
let store: FsSessionStore;

function event(
  scope: Pick<TelemetryEvent, 'sessionId' | 'companySessionId'>,
): TelemetryEvent {
  return {
    queryId: 'query-1',
    pipelineName: 'snapshot-review',
    stage: 'source',
    component: 'context-source',
    durationMs: 12,
    durationBucket: '0-50ms',
    candidatesOut: 3,
    sizeBucket: '0-10',
    ...scope,
  };
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-pipeline-metrics-'));
  dataDir = join(temporaryRoot, 'data');
  projectRoot = join(temporaryRoot, 'project');
  await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 7 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 7, root_path: projectRoot },
      ],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsPipelineTelemetrySink', () => {
  it('writes one immutable JSON per stage without rewriting summary.json', async () => {
    const session = await store.createSession({
      project_id: 7,
      title: 'Pipeline metrics',
      provider: 'test',
      model: 'test',
    });
    const location = await store.getSessionLocation(session.id);
    if (!location) throw new Error('session location was not created');
    const summaryPath = join(location.bundle_path, 'metrics', 'summary.json');
    const summaryBefore = await readFile(summaryPath, 'utf8');
    const sink = new FsPipelineTelemetrySink(store);

    sink.emit(event({ sessionId: session.id }));
    sink.emit({
      ...event({ sessionId: session.id }),
      queryId: 'query-2',
      stage: 'selector',
      component: 'top-k',
    });
    // Unscoped/global pipeline diagnostics have no session bundle and are
    // deliberately ignored instead of becoming a SQLite/global index write.
    sink.emit(event({}));
    await sink.flush();

    const directory = join(
      location.bundle_path,
      'metrics',
      'pipeline_stages',
    );
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(2);
    const rows = await Promise.all(files.map(async (name) =>
      JSON.parse(await readFile(join(directory, name), 'utf8')) as {
        id: string;
        metric_kind: string;
        sessionId: string;
        queryId: string;
      }));
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.every((row) => (
      row.metric_kind === 'pipeline_stage'
      && row.sessionId === session.id
    ))).toBe(true);
    expect(rows.map((row) => row.queryId).sort()).toEqual(['query-1', 'query-2']);
    expect(await readFile(summaryPath, 'utf8')).toBe(summaryBefore);
  });

  it('routes Company metrics to the Company bundle via its UUID', async () => {
    const company = await store.repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: 7 },
      owner_project_id: 7,
      linked_projects: [{ project_id: 7 }],
      title: 'Company metrics',
    });
    const sink = new FsPipelineTelemetrySink(store);

    sink.emit(event({ companySessionId: company.session.id }));
    await sink.flush();

    const files = await readdir(join(
      company.location.bundle_path,
      'metrics',
      'pipeline_stages',
    ));
    expect(files.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });
});

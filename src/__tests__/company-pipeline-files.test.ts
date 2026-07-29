import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
import type { PipelineGraph } from '@mcp/company/types.js';

const GRAPH: PipelineGraph = { version: 1, nodes: [], edges: [] };

describe('Company pipeline filesystem cutover', () => {
  let temporaryRoot: string;
  let dataDir: string;
  let projectRoot: string;
  let db: CodeIndexDB;
  let sessions: FsSessionStore;
  let company: CompanyStore;
  let projectId: number;
  let companySessionId: CompanySessionId;
  let bundlePath: string;

  function makeSessionStore(): FsSessionStore {
    return FsSessionStore.fromRoots({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (candidateId) =>
          candidateId === projectId ? projectRoot : null,
        listProjectRoots: () => [
          { project_id: projectId, root_path: projectRoot },
        ],
      },
    });
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-company-pipeline-fs-'));
    dataDir = join(temporaryRoot, 'data');
    projectRoot = join(temporaryRoot, 'project');
    await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
    db = new CodeIndexDB(join(temporaryRoot, 'index.db'));
    projectId = db.createProject('Pipeline project', projectRoot).id;
    sessions = makeSessionStore();
    const created = await sessions.repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: projectId },
      owner_project_id: projectId,
      linked_projects: [{ project_id: projectId, root_path: projectRoot }],
      title: 'Pipeline team',
      status: 'idle',
    });
    await sessions.refresh();
    companySessionId = asCompanySessionId(String(created.session.id));
    bundlePath = created.location.bundle_path;
    company = new CompanyStore(db.raw(), sessions);
  });

  afterEach(async () => {
    await sessions.close();
    db.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('keeps reusable definitions numeric in minimal SQLite and session definitions as UUID files', async () => {
    const reusable = await company.createPipeline({
      name: 'Reusable',
      graph: GRAPH,
      projectId,
      companySessionId: null,
    });
    const sessionOwned = await company.createPipeline({
      name: 'Session owned',
      graph: GRAPH,
      companySessionId,
    });

    expect(reusable.id).toEqual(expect.any(Number));
    expect(sessionOwned.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionOwned.company_session_id).toBe(companySessionId);
    expect(
      db.raw().prepare('SELECT id, name FROM pipelines ORDER BY id').all(),
    ).toEqual([{ id: reusable.id, name: 'Reusable' }]);
    expect(
      db.raw().prepare('PRAGMA table_info(pipelines)').all()
        .map((column: unknown) => (column as { name: string }).name),
    ).not.toContain('company_session_id');

    const definitionFiles = await readdir(
      join(bundlePath, 'company', 'pipeline-definitions'),
    );
    expect(definitionFiles).toEqual([`${sessionOwned.id}.json`]);

    const listed = await company.listPipelines({ companySessionId });
    expect(listed.map((pipeline) => pipeline.id)).toEqual(
      expect.arrayContaining([sessionOwned.id, reusable.id]),
    );
  });

  it('persists executions and node executions as independent recoverable files', async () => {
    const definition = await company.createPipeline({
      name: 'Session flow',
      graph: GRAPH,
      companySessionId,
    });
    const execution = await company.createPipelineExecution({
      pipelineId: definition.id,
      companySessionId,
      initialInput: 'ship it',
      context: { snapshot: GRAPH, vars: {} },
    });
    const node = await company.createPipelineNodeExecution({
      executionId: execution.id,
      nodeId: 'review',
      nodeLabel: 'Review',
      role: 'qa',
      inputText: 'validate',
    });

    expect(execution).toMatchObject({
      seq: 1,
      pipeline_id: definition.id,
      company_session_id: companySessionId,
      status: 'running',
    });
    expect(node).toMatchObject({
      seq: 1,
      execution_id: execution.id,
      status: 'running',
    });
    await expect(access(join(
      bundlePath,
      'company',
      'pipeline-runs',
      `${execution.id}.json`,
    ))).resolves.toBeUndefined();
    await expect(access(join(
      bundlePath,
      'company',
      'pipeline-node-executions',
      `${node.id}.json`,
    ))).resolves.toBeUndefined();

    await sessions.close();
    sessions = makeSessionStore();
    await sessions.refresh();
    company = new CompanyStore(db.raw(), sessions);

    await expect(company.getPipeline(definition.id)).resolves.toMatchObject({
      id: definition.id,
      company_session_id: companySessionId,
    });
    await expect(company.getPipelineExecution(execution.id)).resolves.toMatchObject({
      id: execution.id,
      pipeline_id: definition.id,
    });
    await expect(company.listPipelineNodeExecutions(execution.id)).resolves.toEqual([
      expect.objectContaining({ id: node.id, execution_id: execution.id }),
    ]);
  });

  it('uses optimistic versioning and recoverable trash without touching reusable SQLite rows', async () => {
    const reusable = await company.createPipeline({
      name: 'Reusable',
      graph: GRAPH,
      projectId,
    });
    const sessionOwned = await company.createPipeline({
      name: 'Before',
      graph: GRAPH,
      companySessionId,
    });

    await expect(company.updatePipeline(
      sessionOwned.id,
      { name: 'After' },
      { expectedVersion: 1 },
    )).resolves.toMatchObject({ name: 'After', version: 2 });
    await expect(company.updatePipeline(
      sessionOwned.id,
      { name: 'Stale writer' },
      { expectedVersion: 1 },
    )).rejects.toMatchObject({ code: 'PIPELINE_VERSION_MISMATCH' });

    await expect(company.deletePipeline(sessionOwned.id)).resolves.toBe(true);
    await expect(company.getPipeline(sessionOwned.id)).resolves.toBeNull();
    await expect(company.getPipeline(reusable.id)).resolves.toMatchObject({
      id: reusable.id,
      name: 'Reusable',
    });
    const trash = await readdir(
      join(bundlePath, '.trash', 'entities', 'company', 'pipeline-definitions'),
    );
    expect(trash.some((file) => file.startsWith(`${sessionOwned.id}.`))).toBe(true);
  });
});

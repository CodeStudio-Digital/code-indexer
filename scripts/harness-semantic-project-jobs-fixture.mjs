import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function runSemanticProjectJobsFixture({ app, dashboard, post, root }) {
  const caseRoot = join(dirname(root), 'semantic-job-pages'); await mkdir(caseRoot);
  const project = await post('/api/projects', { name: 'Semantic job pages', root_path: caseRoot });
  const seed = await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { SemanticStore } = require(join(app.getAppPath(), 'dist/packages/store/src/semantic-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB); const store = new SemanticStore(db.raw());
    let running;
    try {
      const namespace = `semantic:reindex:code:p${projectId}`;
      running = store.createJob({ namespace, kind: 'build' }); store.updateJob(running.id, { status: 'running' });
      const cursor = JSON.stringify({ fixtureHistory: true, detail: 'x'.repeat(2048) });
      db.raw().transaction(() => {
        const insert = db.raw().prepare("INSERT INTO semantic_jobs(namespace,kind,status,cursor) VALUES (?,'build','completed',?)");
        for (let i = 0; i < 10_000; i++) insert.run(namespace, cursor);
      })();
    } finally { store.close(); db.close(); }
    const original = SemanticStore.prototype.listJobs;
    const state = { mainListCalls: 0, longestGapMs: 0, previous: performance.now(), original };
    SemanticStore.prototype.listJobs = function (...args) { state.mainListCalls++; return original.apply(this, args); };
    state.timer = setInterval(() => { const now = performance.now(); state.longestGapMs = Math.max(state.longestGapMs, now - state.previous); state.previous = now; }, 10);
    globalThis.__harnessSemanticJobRead = state;
    return { runningId: running.id, historyRows: 10_000 };
  }, project.id);
  let observation;
  try {
    observation = await dashboard.evaluate(async ({ projectId, runningId }) => {
      const get = async path => {
        const response = await fetch(`mcp://app${path}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Semantic job fixture HTTP ${response.status}`);
        return response.json();
      };
      const before = performance.now();
      const first = await get(`/api/projects/${projectId}/indexing/jobs?limit=25`);
      const next = await get(`/api/projects/${projectId}/indexing/jobs?limit=25&before_id=${first.next_before_id}`);
      const status = await get(`/api/projects/${projectId}/semantic/status`);
      const summary = await get('/api/projects/semantic/status');
      return { elapsedMs: performance.now() - before,
        firstIds: first.jobs.map(row => row.id), nextIds: next.jobs.map(row => row.id), cursor: first.next_before_id,
        detailJob: status.reindex_job?.id, summaryJob: summary.results.find(row => row.project.id === projectId)?.status.reindex_job?.id,
        expectedJob: runningId, statusRows: status.jobs.length, statusCursor: status.next_before_id };
    }, { projectId: project.id, runningId: seed.runningId });
  } finally {
    const metrics = await app.evaluate(({ app }) => {
      const state = globalThis.__harnessSemanticJobRead;
      clearInterval(state.timer);
      const { join } = process.getBuiltinModule('node:path');
      const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
      const { SemanticStore } = require(join(app.getAppPath(), 'dist/packages/store/src/semantic-store.js'));
      SemanticStore.prototype.listJobs = state.original; delete globalThis.__harnessSemanticJobRead;
      return { mainListCalls: state.mainListCalls, longestMainTimerGapMs: state.longestGapMs };
    });
    if (observation) Object.assign(observation, metrics);
  }
  assert.equal(observation.firstIds.length, 25); assert.equal(observation.nextIds.length, 25);
  assert.equal(new Set([...observation.firstIds, ...observation.nextIds]).size, 50);
  assert(observation.nextIds.every(id => id < observation.cursor));
  assert.equal(observation.detailJob, seed.runningId); assert.equal(observation.summaryJob, seed.runningId);
  assert.equal(observation.statusRows, 100); assert(observation.statusCursor > 0);
  assert.equal(observation.mainListCalls, 0, 'Project routes scanned job history in Electron main');
  return { passed: true, ...seed, ...observation };
}

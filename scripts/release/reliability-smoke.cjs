/** Run with the candidate CodeStudio.exe and ELECTRON_RUN_AS_NODE=1.
 * Only disposable local data; asserts launcher/asar/native/process contracts. */
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const root = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
process.env.MCP_DATA_DIR = join(output, 'profile');
mkdirSync(process.env.MCP_DATA_DIR, { recursive: true });
process.env.MCP_INDEX_DB = join(process.env.MCP_DATA_DIR, 'index.db');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(process.env.MCP_DATA_DIR, 'coordination');
const load = name => require(join(root, 'app.asar', 'dist', 'packages', name));
const results = [];
const owned = [];
let complete = false;
process.once('beforeExit', () => {
  if (!complete) {
    console.error('FAIL packaged smoke exited before all checks completed', JSON.stringify(results));
    process.exitCode = 1;
  }
});
async function main() {
  const { CodeIndexDB } = load('store/src/db.js');
  const { buildRepoMap } = load('code-agent/src/core/repo-map.js');
  const projectRoot = join(output, 'project'); mkdirSync(projectRoot, { recursive: true });
  const db = new CodeIndexDB(process.env.MCP_INDEX_DB);
  const project = db.createProject('Packaged configuration', projectRoot);
  try {
    const base = { language: 'ts', size: 50, lineCount: 1, contentHash: 'fixture', summary: '', concepts: [],
      dependencies: [], internalDeps: [], externalDeps: [], notes: [], complexity: 'low', layer: 'config',
      isEntryPoint: false, isTest: false, isGenerated: false };
    writeFileSync(join(projectRoot, 'limits.ts'), 'export const PUBLIC_LIMIT = 17;\n');
    const id = db.upsertFile(project.id, { ...base, path: 'limits.ts' });
    db.upsertSymbols(project.id, id, 'limits.ts', [{ name: 'PUBLIC_LIMIT', kind: 'constant', exported: true,
      signature: 'export const PUBLIC_LIMIT = 17', parent: null, modifiers: [], return_type: null,
      parameters: null, line: 1, comment: null, tags: [] }]);
    writeFileSync(join(projectRoot, 'license-configuration.json'), '{}\n');
    db.upsertFile(project.id, { ...base, path: 'license-configuration.json', language: 'json' });
    const map = buildRepoMap(db, project.id, 1024);
    assert.match(map, /constant PUBLIC_LIMIT/); assert.match(map, /license-configuration\.json/);
  } finally { db.close(); }
  // The agent's index tools run in-process from the packaged port (no MCP child).
  const { createIndexToolsPort } = load('indexer/src/agent-tools/port.js');
  const { buildNativeIndexTools } = load('code-agent/src/tools/native-index-tools.js');
  const { docsTools } = load('code-agent/src/tools/index-docs/docs.js');
  const indexDb = new CodeIndexDB(process.env.MCP_INDEX_DB);
  try {
    const port = createIndexToolsPort({ extraTools: docsTools });
    const tools = buildNativeIndexTools({ port, db: indexDb, binding: { projectName: project.name, projectRoot } });
    const toolCtx = { cwd: projectRoot, projectId: project.id };
    const page = await tools.find(tool => tool.name === 'mcp__get_repo_map').handler({ format: 'json' }, toolCtx);
    assert.notEqual(page.isError, true); assert.match(page.content, /PUBLIC_LIMIT/);
    const grep = await tools.find(tool => tool.name === 'mcp__grep_code').handler({ pattern: 'license', literal: true }, toolCtx);
    assert.notEqual(grep.isError, true);
    assert.deepEqual(grep.structuredData.hits, []);
    assert.deepEqual(grep.structuredData.pathHints, ['license-configuration.json']);
    assert.equal(grep.structuredData.absenceConclusive, false);
    results.push({ configurationRepoMap: 'passed', indexToolsPort: 'passed', mcpPathHints: 'passed' });
  } finally { indexDb.close(); }

  const { superviseCodeExec } = load('code-agent/src/tools/code-exec-supervisor.js');
  const bootstrap = { timeoutMs: 200, maxOutputBytes: 10000, priorityErrorBytes: 1000,
    tools: ['read_step'], schemas: [], listing: [], changes: [], stash: [] };
  let calls = 0, ticks = 0;
  const handlers = { invoke: async () => { calls++; return { answer: 42 }; }, log() {}, logOmission() {}, stash() {}, ready() {} };
  const valid = superviseCodeExec({ ...bootstrap, code: '(async () => { const r = await tools.read_step({}); return r.answer; })()' }, handlers);
  owned.push(valid.pid);
  try { assert.equal(await valid.promise, 42); } finally { await valid.close(); }
  const clock = setInterval(() => ticks++, 10);
  const spinning = superviseCodeExec({ ...bootstrap, code: '(async () => { await tools.read_step({}); while (true) {} })()' }, handlers);
  owned.push(spinning.pid);
  try { await assert.rejects(spinning.promise, /stopped responding|CPU budget|timed out/); }
  finally { clearInterval(clock); await spinning.close(); }
  assert.equal(calls, 2); assert.ok(ticks > 5);
  for (const pid of owned) assert.throws(() => process.kill(pid, 0), `Owned evaluator ${pid} remains alive`);
  results.push({ codeExec: 'passed', postAwaitSpin: 'contained', ownedPids: owned, hostTicks: ticks, cleanup: 'confirmed' });

  const { createSqliteProcessDriver } = load('db-drivers/src/sqlite-process.js');
  const driver = await createSqliteProcessDriver({ engine: 'sqlite', filePath: join(output, 'fixture.sqlite') });
  try {
    await driver.runQuery('CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT)');
    await driver.runQuery("INSERT INTO records VALUES(1,'preserved')");
    assert.deepEqual((await driver.runQuery('SELECT * FROM records', { maxRows: 1 })).rows, [{ id: 1, value: 'preserved' }]);
    await assert.rejects(driver.runQuery('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n', { timeoutMs: 150 }), { code: 'SQLITE_EXECUTOR_RETIRED' });
    await assert.rejects(driver.runQuery('SELECT 1'), { code: 'SQLITE_EXECUTOR_RETIRED' });
  } finally { await driver.close(); }
  const reopened = await createSqliteProcessDriver({ engine: 'sqlite', filePath: join(output, 'fixture.sqlite') });
  try { assert.deepEqual((await reopened.runQuery('SELECT value FROM records')).rows, [{ value: 'preserved' }]); }
  finally { await reopened.close(); }
  results.push({ sqlite: 'passed', nativeCancellation: 'passed', reopen: 'passed' });

  const { ProcessOutput, readProcessOutput } = load('code-agent/src/tools/process-output.js');
  const spool = new ProcessOutput('packaged-owner');
  const content = 'á🙂漢字'.repeat(70); spool.append(content); spool.finish();
  let page = await spool.page(undefined, 29), reconstructed = page.text;
  while (page.nextCursor) { page = await readProcessOutput('packaged-owner', spool.id, page.nextCursor, 29); reconstructed += page.text; }
  assert.equal(reconstructed, content); assert.equal(page.executionState, 'finished');
  assert.throws(() => readProcessOutput('other-owner', spool.id), /not found/);
  results.push({ unicodeOutput: 'passed', ownerIsolation: 'passed', outputId: spool.id });
  writeFileSync(join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), executable: process.execPath,
    resources: root, electron: process.versions.electron, results }, null, 2));
  complete = true;
  console.log('PASS packaged code_exec, child SQLite, cancellation, output pagination and owner cleanup');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

/** Exercise the packaged Electron main process, real bundled weights and public renderer IPC. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

if (!process.argv[2]) throw new Error('Pass the path to the packaged CodeStudio executable');
const executablePath = resolve(process.argv[2]);
const dir = resolve('.tmp/agent-ide-reliability', 'packaged-granite-' + Date.now());
const projectRoot = join(dir, 'project');
mkdirSync(projectRoot, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: projectRoot, windowsHide: true });
writeFileSync(join(projectRoot, 'PackageReceipt.ts'), '// Check a receipt signature before approving a purchase.\nexport function verifyPackageReceipt() { return "signed"; }\n');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(MCP_|CODER_|ELECTRON_RUN_AS_NODE$)/.test(name) || /(?:API_KEY|ACCESS_TOKEN)$/.test(name)) delete env[name];
}
Object.assign(env, { MCP_DATA_DIR: join(dir, 'data'), MCP_INDEX_DB: join(dir, 'data', 'index.db'),
  MCP_RUNTIME_COORDINATION_DIR: join(dir, 'coordination'), MCP_MODEL_CACHE_DIR: join(dir, 'models'),
  MCP_DISABLE_TELEMETRY: '1', PROVIDER_REFRESH_INTERVAL_MS: '0', CODER_PREFLIGHT: '0' });
const app = await electron.launch({ executablePath, env, cwd: dir, timeout: 90000, args: ['--user-data-dir=' + join(dir, 'profile')] });
try {
  const report = await app.evaluate(async ({ app }) => {
    const nodeModule = process.getBuiltinModule('node:module');
    const path = process.getBuiltinModule('node:path');
    const load = nodeModule.createRequire(path.join(app.getAppPath(), 'package.json'));
    const { LocalEmbeddingService } = load('./dist/packages/indexer/src/search/local-embeddings.js');
    const { resolveBundledEmbeddingPath } = load('./dist/packages/indexer/src/search/bundled-model-path.js');
    const cpu = new LocalEmbeddingService({ device: 'cpu' });
    let cpuReport;
    try {
      const { vector } = await cpu.embedQuery('Como verificar um recibo?');
      cpuReport = { provider: cpu.diagnostics().executionProvider, dimension: vector.length, finite: vector.every(Number.isFinite) };
    } finally { await cpu.dispose(); }
    const service = new LocalEmbeddingService();
    try {
      const prefix = 'alpha beta gamma '.repeat(400);
      const { vectors: [a, b, unrelated] } = await service.embed([prefix + ' purchase', prefix + ' verification', 'uma bateria de outro modelo']);
      const query = await service.embedQuery('Como verificar um recibo?');
      const delta = (x, y) => Math.max(...x.map((n, i) => Math.abs(n - y[i])));
      return { packaged: app.isPackaged, resources: process.resourcesPath, weights: resolveBundledEmbeddingPath(),
        diagnostics: service.diagnostics(), cpu: cpuReport, dimension: query.vector.length, tailDelta: delta(a, b), unrelatedDelta: delta(a, unrelated) };
    } finally { await service.dispose(); }
  });
  assert.equal(report.packaged, true);
  assert.ok(report.weights.replaceAll('\\', '/').startsWith(report.resources.replaceAll('\\', '/') + '/semantic-models/'));
  assert.equal(report.dimension, 384);
  assert.deepEqual(report.cpu, { provider: 'cpu', dimension: 384, finite: true });
  assert.ok(report.tailDelta < 0.00001 && report.unrelatedDelta > 0.01, '512-token truncation must only discard the differing tails');
  const deadline = Date.now() + 90000;
  let dashboard;
  while (!dashboard && Date.now() < deadline) {
    dashboard = app.windows().find(page => /dashboard[\\/].*index\.html/.test(page.url()));
    if (!dashboard) await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(dashboard, 'Dashboard must open');
  await dashboard.waitForFunction(() => typeof window.electronAPI?.invoke === 'function');
  const invoke = async (method, payload) => {
    const result = await dashboard.evaluate(({ method, payload }) => window.electronAPI.invoke(method, payload), { method, payload });
    if (!result.ok) throw new Error(method + ' ' + JSON.stringify(result.error));
    return result.value;
  };
  const project = await invoke('projects.create', { name: 'Granite fixture', root_path: projectRoot });
  const activation = { id: project.id, activationId: 'rag-package', clientId: 'rag-package' };
  await invoke('projects.activate', activation);
  let hits = [];
  const started = Date.now();
  while (!hits.length && Date.now() - started < 90000) {
    ({ results: hits } = await invoke('search.project', { projectId: project.id, query: 'verifyPackageReceipt', mode: 'fts', limit: 10 }));
    if (!hits.length) await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(hits.some(hit => (hit.data.name ?? hit.data.file_path ?? hit.data.path ?? '').includes('PackageReceipt')));
  Object.assign(report, { projectId: project.id, ftsHits: hits.length, activationToHitMs: Date.now() - started });
  const folders = await dashboard.evaluate(async id => {
    const response = await fetch('/api/projects/' + id + '/semantic/folders', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folders: ['.'] }),
    });
    if (!response.ok) throw new Error('Set semantic folders: ' + response.status + ' ' + await response.text());
    return response.json();
  }, project.id);
  assert.deepEqual(folders.folders, ['.']);
  const semanticStart = Date.now();
  let semantic;
  do {
    semantic = await invoke('search.project', { projectId: project.id, query: 'Como confirmar um comprovante de compra?',
      mode: 'hybrid', limit: 10, bypassCache: true });
    if (semantic.diagnostics.vectorRehydrated > 0) break;
    await new Promise(done => setTimeout(done, 500));
  } while (Date.now() - semanticStart < 120000);
  const diagnostics = semantic.diagnostics;
  assert.ok(diagnostics.generationUsed > 0 && diagnostics.vectorRawMatches > 0 && diagnostics.vectorRehydrated > 0,
    'Packaged search must query an active generation: ' + JSON.stringify(diagnostics));
  assert.ok(semantic.results.some(hit => (hit.data.file_path ?? hit.data.path ?? '').endsWith('PackageReceipt.ts')));
  Object.assign(report, { semantic: { generation: diagnostics.generationUsed, embedder: diagnostics.embedder,
    candidates: diagnostics.vectorRehydrated, activationToHybridMs: Date.now() - semanticStart } });
  await invoke('projects.deactivate', activation);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, ...report }));
} finally { await app.close(); }

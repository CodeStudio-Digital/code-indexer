/** Exercise the packaged Electron main process, real bundled weights and public renderer IPC.
 * Pass --openrouter-free to also run the packaged NVIDIA adapters on fixed synthetic inputs.
 */
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
  if (process.argv.includes('--openrouter-free')) {
    report.nemotron = await app.evaluate(probeFreeNemotron);
    assert.equal(report.nemotron.embedding.dimension, 2048);
    assert.equal(report.nemotron.ranking.model, 'nvidia/nemotron-3.5-rerank-8b:free');
    assert.equal(report.nemotron.requests, 3);
    assert.equal(report.nemotron.costUSD, 0);
  }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ dir, ...report }));
} finally { await app.close(); }

// Playwright serializes this function into the main process of the packaged app.
async function probeFreeNemotron({ app }) {
  const path = process.getBuiltinModule('node:path');
  const os = process.getBuiltinModule('node:os');
  const load = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
  const { probeEmbeddingTarget, probeRerankerTarget } = load('./dist/packages/indexer/src/search/semantic-targets.js');
  const Database = load('better-sqlite3');
  const catalog = new Database(path.join(os.homedir(), '.mcp-code-indexer', 'index.db'), { readonly: true, fileMustExist: true });
  let provider;
  try {
    provider = catalog.prepare("SELECT id,kind,base_url,enabled,api_key FROM provider_configs WHERE id='openrouter' AND enabled=1").get();
  } finally { catalog.close(); }
  const base = 'https://openrouter.ai/api/v1';
  if (!provider?.api_key || (provider.base_url && provider.base_url.replace(/\/$/, '') !== base)) throw new Error('Expected the configured OpenRouter provider');
  const store = { getProvider: id => id === 'openrouter' ? provider : null };
  const embed = 'nvidia/nemotron-3-embed-1b:free';
  const rerank = 'nvidia/nemotron-3.5-rerank-8b:free';
  const requests = new Map([
    [JSON.stringify({ model: embed, input: ['passage: semantic probe document', 'passage: different retrieval passage'] }), base + '/embeddings'],
    [JSON.stringify({ model: embed, input: ['query: semantic probe query'] }), base + '/embeddings'],
    [JSON.stringify({ model: rerank, query: 'cache implementation', documents: [
      'The cache stores values and evicts least recently used entries.', 'This function paints a blue button.',
    ], top_n: 2 }), base + '/rerank'],
  ]);
  const previousFetch = globalThis.fetch;
  const usage = { requests: 0, costReports: 0, costUSD: 0 };
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'POST' || requests.get(init.body) !== String(url)) throw new Error('Request outside the fixed Nemotron fixture');
    requests.delete(init.body);
    const response = await previousFetch(url, { ...init, redirect: 'error' });
    const reported = (await response.clone().json()).usage;
    if (typeof reported?.cost === 'number') { usage.costUSD += reported.cost; usage.costReports++; }
    usage.requests++;
    return response;
  };
  try {
    const embedding = await probeEmbeddingTarget({ kind: 'provider', providerId: 'openrouter', model: embed,
      protocol: 'openai-embeddings', inputFormat: 'query-passage' }, store);
    const ranking = await probeRerankerTarget({ kind: 'provider', providerId: 'openrouter', model: rerank, protocol: 'openai-rerank' }, store);
    return { embedding, ranking, ...usage };
  } finally { globalThis.fetch = previousFetch; }
}

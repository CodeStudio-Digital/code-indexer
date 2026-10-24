import { nativeAgentReadsDelta, runNativeAgentReadsFixture } from './harness-native-agent-reads-fixture.mjs';
import { legacyWorktreeDelta, runLegacyWorktreeFixture } from './harness-legacy-worktree-fixture.mjs';
import { runSemanticProjectJobsFixture } from './harness-semantic-project-jobs-fixture.mjs';
import { nativeCodeExecDelta, runNativeCodeExecFixture, recoverNativeCodeExecFixture } from './harness-native-code-exec-fixture.mjs';
import { runNativeSpecUiFixture } from './harness-native-spec-ui-fixture.mjs';
import { nativeSpecDelta, runNativeSpecFixture, recoverNativeSpecFixture } from './harness-native-spec-fixture.mjs';
import { nativeTasksDelta, runNativeTasksFixture, recoverNativeTasksFixture } from './harness-native-tasks-fixture.mjs';
import { nativeTreeDelta, runNativeTreeFixture, recoverNativeTreeFixture } from './harness-native-tree-fixture.mjs';
import { createSelfReviewFixture, respondSelfReview, nativeSelfReviewDelta, runNativeSelfReviewFixture, recoverNativeSelfReviewFixture } from './harness-native-self-review-fixture.mjs';
import { nativeTaskCompleteDelta, runNativeTaskCompleteFixture, recoverNativeTaskCompleteFixture } from './harness-native-task-complete-fixture.mjs';
import { nativeWorkflowDelta, runNativeWorkflowFixture, recoverNativeWorkflowFixture } from './harness-native-workflow-fixture.mjs';
import { nativeExecuteTasksDelta, runNativeExecuteTasksFixture, recoverNativeExecuteTasksFixture } from './harness-native-execute-tasks-fixture.mjs';
import { nativeWorktreeToolsDelta, runNativeWorktreeToolsFixture } from './harness-native-worktree-tools-fixture.mjs';
// Complete packaged product path with a deterministic loopback-only provider.
// No real credentials, user profile, existing projects or cloud provider calls.
import assert from 'node:assert/strict';
import { probeOtherProfile } from './harness-cohort-fixture.mjs';
import { seedExistingProjectFixture, verifyExistingProjectFixture } from './harness-existing-project-fixture.mjs';
import { nativePathDelta, runNativePathFixture, assertNativePathFiles } from './harness-native-path-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { startMcpStdioFixture } from './harness-mcp-stdio-fixture.mjs';
import { startMcpFixture, runMcpFixture, assertMcpRecovery } from './harness-mcp-fixture.mjs';
import { preparePersistentCommandFixture, persistentCommandDelta, runPersistentCommandFixture } from './harness-persistent-command-fixture.mjs';
import { assertHistoryQueries } from './harness-history-queries.mjs';
import { reservePublicMcpPort, runPublicMcpFixture, assertPublicMcpAfterRestart } from './harness-public-mcp.mjs';
import { runCliFixture } from './harness-cli-fixture.mjs';
import { interactionDelta, runInteractionFixture } from './harness-interaction-fixture.mjs';
import { runPreparationStopFixture } from './harness-preparation-stop-fixture.mjs';
import { prepareNativePreviewFixture, nativePreviewDelta, runNativePreviewFixture, assertNativePreviewRecovery } from './harness-native-preview-fixture.mjs';
import { startNativeBrowserFixture, nativeBrowserDelta, runNativeBrowserFixture, assertNativeBrowserRecovery } from './harness-native-browser-fixture.mjs';
import { startNativeDatabaseFixture, nativeDatabaseDelta, runNativeDatabaseFixture, assertNativeDatabaseRecovery } from './harness-native-db-fixture.mjs';
import { nativeOutputDelta, runNativeOutputFixture, recoverNativeOutputFixture } from './harness-native-output-fixture.mjs';
import { startNativeHttpFixture, nativeHttpDelta, runNativeHttpFixture, assertNativeHttpRecovery } from './harness-native-http-fixture.mjs';

import { startNativeApiFixture, nativeApiDelta, runNativeApiFixture, assertNativeApiRecovery } from './harness-native-api-fixture.mjs';
import { startNativeWebFixture, nativeWebDelta, runNativeWebFixture } from './harness-native-web-fixture.mjs';
import { nativeDocsDelta, runNativeDocsFixture } from './harness-native-docs-fixture.mjs';
import { nativeInspectionDelta, runNativeInspectionFixture } from './harness-native-inspection-fixture.mjs';
import { nativeLspDelta, runNativeLspFixture } from './harness-native-lsp-fixture.mjs';
import { nativeIndexDelta, runNativeIndexFixture } from './harness-native-index-fixture.mjs';
import { nativeCostsDelta, runNativeCostsFixture } from './harness-native-costs-fixture.mjs';
import { nativeExportDelta, runNativeExportFixture, recoverNativeExportFixture } from './harness-native-export-fixture.mjs';
import { nativeIndexMutationDelta, runNativeIndexMutationFixture, recoverNativeIndexMutationFixture } from './harness-native-index-mutation-fixture.mjs';
import { nativeModelsDelta, runNativeModelsFixture } from './harness-native-models-fixture.mjs';
import { nativeDirectoryDelta, runNativeDirectoryFixture } from './harness-native-directory-fixture.mjs';
import { nativeMemoryPagesDelta, runNativeMemoryPagesFixture } from './harness-native-memory-pages-fixture.mjs';
import { nativeMemoryWritesDelta, runNativeMemoryWritesFixture, recoverNativeMemoryWritesFixture } from './harness-native-memory-writes-fixture.mjs';
import { nativeSkillAuthoringDelta, runNativeSkillAuthoringFixture, recoverNativeSkillAuthoringFixture } from './harness-native-skill-authoring-fixture.mjs';
import { nativeDiagramsDelta, runNativeDiagramsFixture } from './harness-native-diagrams-fixture.mjs';
import { nativeGoalsDelta, runNativeGoalsFixture, finishNativeGoalsFixture, assertNativeGoal } from './harness-native-goals-fixture.mjs';
import { nativeDiscoveryDelta, runNativeDiscoveryFixture } from './harness-native-discovery-fixture.mjs';
import { nativeSessionDataDelta, runNativeSessionDataFixture, recoverNativeSessionDataFixture, assertNativeSessionNotes } from './harness-native-session-data-fixture.mjs';
import { nativeEditContextDelta, runNativeEditContextFixture } from './harness-native-edit-context-fixture.mjs';
import { nativeSemanticNeighborsDelta, runNativeSemanticNeighborsFixture } from './harness-native-semantic-neighbors-fixture.mjs';
import { nativeSymbolToolsDelta, runNativeSymbolToolsFixture } from './harness-native-symbol-tools-fixture.mjs';
import { nativeFileToolsDelta, runNativeFileToolsFixture } from './harness-native-file-tools-fixture.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? 'scratch/harness-electron-admission');
const executablePath = resolve(process.argv[3] ?? 'dist/electron-builder/win-unpacked/CodeStudio.exe');
const native = process.argv.includes('--native');
const unpackaged = process.argv.includes('--unpackaged');
const attachments = native && process.argv.includes('--attachments');
const restart = native && process.argv.includes('--restart');
const filesystem = native && process.argv.includes('--filesystem');
const toolImages = native && process.argv.includes('--tool-images');
const search = native && process.argv.includes('--search');
const commands = native && process.argv.includes('--commands');
const continuation = native && process.argv.includes('--continue');
const knowledge = native && process.argv.includes('--knowledge');
const proactiveMemory = knowledge && process.argv.includes('--proactive-memory');
const worktree = native && process.argv.includes('--worktree');
const cohort = process.argv.includes('--cohort');
const pty = native && process.argv.includes('--pty');
const persistent = native && (process.argv.includes('--persistent') || pty);
if (worktree) assert(filesystem && !commands, 'worktree fixture requires --filesystem without --commands');
const stdioMcp = process.argv.includes('--mcp-stdio');
const externalMcp = stdioMcp || process.argv.includes('--mcp');
const publicMcp = process.argv.includes('--public-mcp');
const cli = process.argv.includes('--cli');
const interactions = native && process.argv.includes('--interactions');
const preparationStop = native && process.argv.includes('--preparation-stop');
const nativePreview = native && process.argv.includes('--preview');
const nativeBrowser = native && process.argv.includes('--browser');
const nativeDatabase = native && process.argv.includes('--database');
const nativeOutput = native && process.argv.includes('--output-recovery');
const nativeHttp = native && process.argv.includes('--http');
const nativeApi = native && process.argv.includes('--api-client');
const nativeWeb = native && process.argv.includes('--web');
const nativeDocs = native && (process.argv.includes('--rag') || process.argv.includes('--mcp-docs'));
const docsFixture = { mcp: native && process.argv.includes('--mcp-docs') };
const nativeInspection = native && process.argv.includes('--inspection');
const inspectionFixture = {};
const nativeLsp = native && process.argv.includes('--lsp');
const nativeRepoMap = native && process.argv.includes('--repo-map');
const nativeIndex = native && (nativeRepoMap || process.argv.includes('--index-navigation'));
const nativeCosts = native && process.argv.includes('--costs');
const nativeExport = native && process.argv.includes('--export-docs');
const nativeIndexMutation = native && process.argv.includes('--index-mutation');
const nativeModels = native && process.argv.includes('--models');
const nativeAgentReads = native && process.argv.includes('--agent-reads');
const agentReadsFixture = {};
const nativeDirectory = native && process.argv.includes('--directory');
const nativeMemoryPages = native && process.argv.includes('--memory-pages');
const nativeMemoryWrites = native && process.argv.includes('--memory-writes');
const nativeSkillAuthoring = native && process.argv.includes('--skill-authoring');
const existingProject = process.argv.includes('--existing-project');
const nativePaths = native && process.argv.includes('--paths');
const nativeDiagramExport = native && process.argv.includes('--diagram-export');
const nativeDiagrams = native && (nativeDiagramExport || process.argv.includes('--diagrams'));
const nativeGoals = native && process.argv.includes('--goals');
const nativeScripts = native && process.argv.includes('--code-exec');
const scriptFixture = {};
const nativeTasks = native && process.argv.includes('--tasks');
const nativeTree = native && process.argv.includes('--agent-tree');
const nativeSelfReview = native && process.argv.includes('--self-review');
const nativeTaskComplete = native && process.argv.includes('--task-complete');
const nativeWorkflow = native && process.argv.includes('--workflow');
const workflowFixture = { childProviderRequests: 0 };
const nativeExecuteTasks = native && process.argv.includes('--execute-tasks');
const nativeWorktreeTools = native && process.argv.includes('--worktree-tools');
const executeTasksFixture = { childProviderRequests: 0 };
const selfReviewFixture = nativeSelfReview ? createSelfReviewFixture() : undefined;
const nativeSpecs = native && process.argv.includes('--specs');
const nativeDiscovery = native && process.argv.includes('--discovery');
const nativeSessionData = native && process.argv.includes('--session-data');
let sessionDataFixture;
const nativeEditContext = native && process.argv.includes('--edit-context');
const nativeSemanticNeighbors = native && process.argv.includes('--semantic-neighbors');
const nativeSymbolTools = native && process.argv.includes('--symbol-tools');
const nativeFileTools = native && process.argv.includes('--file-tools');
if (cli && !native) throw new Error('CLI fixture requires --native');
let cliCancelStarted = false;
if (publicMcp && !native) throw new Error('Public MCP fixture currently requires the native development route');
const publicMcpPort = (publicMcp || nativeSemanticNeighbors || nativeMemoryPages) ? await reservePublicMcpPort() : undefined;
const knowledgeCalls = knowledge ? [
  ['namespace', 'list_skill_namespaces', {}], ['skills', 'get_skills_list', {}],
  ['content', 'get_skill_content', { skill_id: 'harness-review' }],
  ['invoke', 'invoke_skill', { skill_id: 'harness-review' }],
  ['memory', 'recall_memory', { query: 'harness memory convention' }],
  ['memory-index', 'recall_memory', { mode: 'list' }],
] : [];
const expectedToolCount = 4 + Number(toolImages) + Number(search) + knowledgeCalls.length;
const toolImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const attachmentImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=';
const startupTracePath = process.env.MCP_HARNESS_STARTUP_TRACE === '1' ? join(output, 'startup-trace.json') : undefined;
await mkdir(output, { recursive: true });
const isolated = await mkdtemp(join(tmpdir(), 'codestudio-admission-'));
const projectRoot = join(isolated, 'project');
await mkdir(projectRoot);
const mcpFixture = externalMcp ? await (stdioMcp ? startMcpStdioFixture : startMcpFixture)(projectRoot) : undefined;
if (toolImages) await writeFile(join(projectRoot, 'tool-image.png'), Buffer.from(toolImage, 'base64'));
if (attachments) {
  await writeFile(join(isolated, 'attachment.png'), Buffer.from(attachmentImage, 'base64'));
  await writeFile(join(isolated, 'attachment.txt'), 'HARNESS_DOCUMENT_CONTENT');
}
await writeFile(join(projectRoot, 'fixture.txt'), 'harness-file-content\n');
if (persistent) await preparePersistentCommandFixture(projectRoot);
if (nativePreview) await prepareNativePreviewFixture(projectRoot);
const readFixtures = ['fixture.txt', 'fixture-2.txt', 'fixture-3.txt', 'fixture-4.txt'];
await Promise.all(readFixtures.slice(1).map((path, index) => writeFile(join(projectRoot, path), `harness-file-content-${index + 2}\n`)));
if (worktree) {
  const git = args => execFileSync('git', args, { cwd: projectRoot, windowsHide: true, timeout: 10_000, stdio: 'pipe' });
  git(['init', '--initial-branch=main']); git(['config', 'core.autocrlf', 'false']);
  git(['add', '--', ...readFixtures]);
  git(['-c', 'user.name=Harness', '-c', 'user.email=harness@example.invalid', 'commit', '-m', 'worktree fixture']);
}
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(MCP_|CODER_|CODESTUDIO_NATIVE_CODER_DEV$|CODESTUDIO_NATIVE_MCP_STDIO_DEV$|CODESTUDIO_RUNTIME_COHORT_GUARD$|ELECTRON_RUN_AS_NODE$)/.test(name) || /(?:API_KEY|ACCESS_TOKEN)$/.test(name)) delete env[name];
}
Object.assign(env, { MCP_DATA_DIR: join(isolated, 'data'), MCP_MODEL_CACHE_DIR: join(isolated, 'models'),
  MCP_RUNTIME_COORDINATION_DIR: join(isolated, 'coordination'),
  MCP_INDEX_DB: join(isolated, 'data', 'index.db'), MCP_DISABLE_TELEMETRY: '1', CODER_PREFLIGHT: '0',
  PROVIDER_REFRESH_INTERVAL_MS: '0',
  CODER_CONTROL_PLANE_SHADOW: '0', CODER_AGENT_RUN_STORE_SHADOW: '0', CODER_AGENT_RUN_STORE_ENFORCE: '0' });
if (native) env.CODESTUDIO_NATIVE_CODER_DEV = '1';
if (existingProject) { env.MCP_PROJECT_DB = '1'; env.MCP_PROJECT_DB_ROUTE = '1'; }
if (cohort) env.CODESTUDIO_RUNTIME_COHORT_GUARD = '1';
if (stdioMcp) env.CODESTUDIO_NATIVE_MCP_STDIO_DEV = '1';
if (publicMcp || nativeSemanticNeighbors || nativeMemoryPages) Object.assign(env, { MCP_DEV_HTTP: '1', MCP_INDEX_PORT: String(publicMcpPort),
  MCP_HTTP_ENABLED: 'true', MCP_HTTP_PATH: '/mcp' });
const report = { schemaVersion: 1, executablePath, isolated, projectRoot,
  packaged: !unpackaged, stdioMcp, publicMcp, cli, interactions, preparationStop, attachments, restart, filesystem, toolImages, search, commands, continuation, knowledge, proactiveMemory, worktree, cohort, persistent, pty,
  scope: native ? 'Native development route; four-read batch, optional tool image, search, approved filesystem/command effects, history reload, follow-up command, cancellation, optional interrupted continuation and restart; loopback provider; isolated profile'
    : 'Packaged facade/legacy worker; four-read batch, resume, approved write and cancellation; loopback provider; isolated profile',
  candidate: { platform: process.platform, arch: process.arch, harnessNode: process.version,
    ...(unpackaged ? { compiledMainSha256: await fileSha256(join(repo, 'dist/apps/electron/main.js')) }
      : { appAsarSha256: await fileSha256(join(dirname(executablePath), 'resources', 'app.asar')) }),
    executableSha256: await fileSha256(executablePath), profile: 'fresh per run', osFileCache: 'uncontrolled' },
  startedAt: new Date().toISOString(), requests: [], auxiliaryRequests: [], errors: [] };
let app;
let browserFixture;
let databaseFixture;
let httpFixture;
let apiFixture;
let webFixture;
let memoryPagesFixture;
let dashboard;
let stderrTail = '';
let sessionId;
let providerFailure;
let toolResponseSeen = false;
let observeCancelProvider;
const cancelProviderStarted = new Promise(resolve => { observeCancelProvider = resolve; });
let cancelProviderClosed = false;
let observePausedProvider;
const pausedProviderStarted = new Promise(resolve => { observePausedProvider = resolve; });
let resumeAllowed = false;
let publicMcpCancelStarted = false;
let publicMcpCancelClosed = false;

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function persistedAdmission() {
  const files = await readdir(isolated, { recursive: true });
  if (native) return persistedNativeAdmission(files);
  let entry;
  let run;
  for (const path of files.filter(path => /events[\\/]attempt-preparations[\\/][^\\/]+\.json$/.test(path))) {
    const candidate = JSON.parse(await readFile(join(isolated, path), 'utf8'));
    if (candidate.data.preparation.sessionId !== sessionId) continue;
    const runPath = files.find(path => path.replaceAll('\\', '/').endsWith(`/events/runs/${candidate.data.preparation.agentRunId}.json`));
    if (!runPath) continue;
    const candidateRun = JSON.parse(await readFile(join(isolated, runPath), 'utf8')).data.run;
    if (candidateRun.status !== 'running') continue;
    assert(!entry, 'more than one active attempt for the session');
    entry = candidate;
    run = candidateRun;
  }
  assert(entry, 'provider was called before admission and durable activation existed on disk');
  const preparation = entry.data.preparation;
  assert.equal(preparation.sessionId, sessionId);
  assert.equal(preparation.provider, 'harness-local');
  assert.equal(preparation.model, 'harness-model');
  assert.equal(entry.data.admission.runtimeGeneration, 'legacy_ts');
  assert.equal(run.status, 'running', 'provider was called before durable activation');
  assert.equal(run.effectiveModel, 'harness-model');
  const routeFile = files.find(path => path.replaceAll('\\', '/').endsWith(`/events/runtime-routes/${entry.data.admission.attemptId}.json`));
  assert(routeFile, 'provider was called before the facade committed its runtime route');
  const route = JSON.parse(await readFile(join(isolated, routeFile), 'utf8')).data.route;
  assert.equal(route.runtimeGeneration, 'legacy_ts');
  assert(preparation.capabilitySet.registered.includes('cap:native:docs_deep_research'), 'host DocsAgent tool was not admitted before catalogue sealing');
  assert.equal(route.preference, 'legacy_required');
  assert.equal(route.provider, preparation.provider);
  assert.equal(route.capabilityCatalogVersion, preparation.capabilitySet.catalogVersion);
  assert.deepEqual(route.capabilityIds, preparation.capabilitySet.eligible);
  assert.match(route.runtimeBuildId, /^legacy-worker-entrypoint:[a-f0-9]{64}$/);
  return { agentRunId: preparation.agentRunId, preparationSha256: entry.data.admission.preparationSha256,
    runtimeRoute: route, capabilities: preparation.capabilitySet.registered.length, bytes: Buffer.byteLength(JSON.stringify(entry)) };
}

async function persistedNativeAdmission(files) {
  const records = await Promise.all(files.filter(path => /events[\\/]native-preparations[\\/][^\\/]+\.json$/.test(path))
    .map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8'))));
  for (const record of records.filter(record => sessionId === undefined || record.relations.session === sessionId)) {
    const attemptId = record.relations.attempt;
    const readRecord = async (folder, id) => {
      const path = files.find(path => path.replaceAll('\\', '/').endsWith(`/events/${folder}/${id}.json`));
      assert(path, `native ${folder} record absent before provider start`);
      return JSON.parse(await readFile(join(isolated, path), 'utf8'));
    };
    const run = (await readRecord('runs', record.relations.run)).data.run;
    if (run.status !== 'running') continue;
    const route = (await readRecord('runtime-routes', attemptId)).data.route;
    assert.equal(route.runtimeGeneration, 'rust_v1');
    assert.equal(route.preference, 'rust_required');
    assert.equal(run.effectiveProvider, 'harness-local');
    assert.equal(run.effectiveModel, 'harness-model');
    const activations = await Promise.all(files.filter(path => /events[\\/]native-activations[\\/][^\\/]+\.json$/.test(path))
      .map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8'))));
    assert(activations.some(record => record.relations.attempt === attemptId), 'native activation absent before provider');
    const legacyPreparations = await Promise.all(files.filter(path => /events[\\/]attempt-preparations[\\/][^\\/]+\.json$/.test(path))
      .map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8'))));
    assert(!legacyPreparations.some(record => record.relations.attempt === attemptId
      || record.data.admission?.attemptId === attemptId), 'legacy preparation exists in native attempt');
    return { sessionId: record.relations.session, agentRunId: run.agentRunId, runtimeRoute: route, nativePreparation: record.id };
  }
  assert.fail('native provider started before durable preparation and running state');
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'harness-model', object: 'model' }] }));
      return;
    }
    assert(request.url?.endsWith('/chat/completions'), `unexpected provider endpoint ${request.url}`);
    let encoded = '';
    for await (const chunk of request) encoded += chunk;
    const body = JSON.parse(encoded);
    assert.equal(body.model, 'harness-model');
    // Session titles and other auxiliary tasks share the configured provider,
    // but have no tool catalog and are not an agent execution attempt.
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      if (nativeSelfReview && respondSelfReview(body, response, selfReviewFixture)) return;
      report.auxiliaryRequests.push({ stream: body.stream === true,
        systemPrefix: String(body.messages.find(message => message.role === 'system')?.content ?? '').slice(0, 150) });
      assert(body.stream !== true, 'unexpected tool-free streaming provider request');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'local-auxiliary', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Harness fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    const admission = await persistedAdmission();
    if (proactiveMemory && body.messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('<recalled_context>')
      && JSON.stringify(message.content).includes('HARNESS_MEMORY_PROOF'))) report.proactiveMemoryReceived = true;
    if (knowledge && body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_CASE'))
      && !body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_FOLLOWUP_CASE'))) {
      assert(body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('<active_skills>')
        && JSON.stringify(message.content).includes('HARNESS_SKILL_PROOF Harness fixture')), 'selected skill context did not reach provider at user priority');
      report.selectedSkillProviderReceived = true;
    }
    if (attachments && JSON.stringify(body.messages).includes('HARNESS_CASE')) {
      assert(JSON.stringify(body.messages).includes(`data:image/png;base64,${attachmentImage}`), 'provider lost the attached image');
      assert(JSON.stringify(body.messages).includes('HARNESS_DOCUMENT_CONTENT'), 'provider lost the attached document');
      assert(JSON.stringify(body.messages).includes('attachment.txt'), 'provider lost the document name');
    }
    const toolMessages = body.messages.filter(message => message.role === 'tool');
    const readMessages = toolMessages.filter(message => message.tool_call_id?.startsWith('harness-read-'));
    const primaryConversation = body.messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes('HARNESS_CASE'));
    if (readMessages.length) {
      assert.deepEqual(readMessages.map(message => message.tool_call_id), readFixtures.map((_, index) => `harness-read-${index + 1}`));
      for (const message of readMessages) assert(JSON.stringify(message.content).includes('harness-file-content'), 'read batch lost a result');
      if (toolImages && primaryConversation) assert(JSON.stringify(body.messages).includes(`data:image/png;base64,${toolImage}`), 'provider lost the tool image');
      if (search && primaryConversation) {
        const result = toolMessages.find(message => message.tool_call_id === 'harness-grep-1');
        assert(result && JSON.stringify(result.content).includes('harness-file-content'), 'MCP search lost its real file result');
        report.searchResultReceived = true;
      }
      if (knowledge && primaryConversation) {
        for (const id of ['content', 'invoke']) assert(toolMessages.some(message =>
          message.tool_call_id === `harness-${id}` && JSON.stringify(message.content).includes('HARNESS_SKILL_PROOF Harness fixture')),
        `skill ${id} lost its resolved instructions`);
        assert(toolMessages.some(message => message.tool_call_id === 'harness-memory'
          && JSON.stringify(message.content).includes('HARNESS_MEMORY_PROOF')), 'explicit memory lost its stored content');
        assert(toolMessages.some(message => message.tool_call_id === 'harness-memory-index'
          && JSON.stringify(message.content).includes('harness-memory-convention')), 'memory index missing');
        report.knowledgeReceived = true;
      }
      if (native && !report.liveHistoryDuringProvider) {
        // Keep this provider response pending while HTTP reads the writer's
        // committed prefix. A second read must agree without replaying tools.
        const histories = await dashboard.evaluate(async id => {
          const results = [];
          for (let index = 0; index < 3; index++) {
            const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`, { signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error(`live native history ${response.status}: ${await response.text()}`);
            results.push(await response.json());
          }
          return results;
        }, sessionId);
        for (const history of histories) {
          assert.equal(history.messages.filter(message => message.role === 'tool').length, expectedToolCount);
          assert(JSON.stringify(history.messages).includes('harness-file-content'));
          if (toolImages) assert(JSON.stringify(history.messages).includes(toolImage));
        }
        assert.deepEqual(histories[1].messages, histories[0].messages);
        assert.deepEqual(histories[2].messages, histories[0].messages);
        report.liveHistoryQueries = await assertHistoryQueries(dashboard, sessionId, histories[0]);
        report.liveHistoryDuringProvider = true;
      }
    }
    toolResponseSeen ||= toolMessages.some(message => JSON.stringify(message.content).includes('harness-file-content'));
    const verificationReminder = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
      .includes('[verification-required]');
    const followup = JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '').includes('HARNESS_FOLLOWUP_CASE');
    const worktreeFollowup = worktree && JSON.stringify(body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '').includes('HARNESS_WORKTREE_FOLLOWUP');
    if (worktreeFollowup) assert.equal(toolMessages.length, 1, 'worktree follow-up lost or replayed the write');
    if (followup) {
      assert.equal(toolMessages.length, expectedToolCount, 'next user command lost or duplicated tool history');
      assert(body.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('HARNESS_RESULT_OK')),
        'next user command lost the previous assistant answer');
      assert(body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_CASE')),
        'next user command lost the previous user input');
    }
    report.requests.push({ at: new Date().toISOString(), model: body.model, toolResults: toolMessages.length, verificationReminder, admission });
    const publicCase = (publicMcp || cli) && JSON.stringify(body.messages).match(/HARNESS_(?:PUBLIC_MCP|CLI)_(COMPLETE|CANCEL|FAILURE)/)?.[1];
    if (publicCase === 'FAILURE') {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Intentional public MCP provider failure', type: 'invalid_request_error', code: 'harness_failure' } }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (publicCase === 'CANCEL') {
      if (JSON.stringify(body.messages).includes('HARNESS_CLI_CANCEL')) cliCancelStarted = true;
      publicMcpCancelStarted = true;
      response.on('close', () => { publicMcpCancelClosed = true; });
      response.write(': public MCP provider awaiting cancellation\n\n');
      return;
    }
    const pausing = continuation && body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_PAUSE_CASE'));
    if (pausing && toolMessages.length && !resumeAllowed) {
      response.write(': paused after committed tool result\n\n');
      observePausedProvider(admission);
      return;
    }
    if (pausing && resumeAllowed) {
      assert.equal(toolMessages.length, 1, 'continuation lost or repeated the settled read');
      assert.equal(body.messages.filter(message => message.role === 'user').length, toolImages ? 2 : 1, 'continuation changed tool attachment/user messages');
      if (toolImages) assert(JSON.stringify(body.messages).includes(`data:image/png;base64,${toolImage}`), 'continuation lost its durable tool image');
      assert(!JSON.stringify(body.messages).includes('without adding a user message'));
      report.continuationProviderValidated = true;
    }
    if (body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_CANCEL_CASE'))) {
      response.on('close', () => { cancelProviderClosed = true; });
      response.write(`data: ${JSON.stringify({ id: 'local-cancel', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Working...' }, finish_reason: null }] })}\n\n`);
      observeCancelProvider(admission);
      return;
    }
    const writing = body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_APPROVAL_CASE'));
    const mcpCase = externalMcp && body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('HARNESS_MCP_CASE'));
    if (mcpCase) {
      assert(admission.runtimeRoute.capabilityIds.includes('cap:mcp_external:ext_harness-ext__mutate'), 'MCP missing from admitted catalogue');
      if (toolMessages.length) assert(toolMessages.some(message => message.tool_call_id === 'harness-mcp-discover'
        && JSON.stringify(message.content).includes('ext_harness-ext__mutate')), 'MCP discovery lost the registered tool');
    }
    if (commands && writing && toolMessages.length) {
      assert(toolMessages.some(message => JSON.stringify(message.content).includes('?? approved.txt')), 'native Git did not inspect the command result');
      report.commandAndGitCompleted = true;
    }
    const delta = (nativeWorktreeTools && nativeWorktreeToolsDelta(body)) || (nativeExecuteTasks && nativeExecuteTasksDelta(body, executeTasksFixture)) || (nativeWorkflow && nativeWorkflowDelta(body, workflowFixture)) || (nativeTaskComplete && nativeTaskCompleteDelta(body)) || (nativeSelfReview && nativeSelfReviewDelta(body)) || (nativeTree && nativeTreeDelta(body)) || (!native && legacyWorktreeDelta(body)) || (nativeIndexMutation && nativeIndexMutationDelta(body)) || (nativeAgentReads && nativeAgentReadsDelta(body, agentReadsFixture)) || (nativeExport && nativeExportDelta(body)) || (nativeScripts && nativeCodeExecDelta(body, scriptFixture)) || (nativeSpecs && nativeSpecDelta(body)) || (nativeTasks && nativeTasksDelta(body)) || (nativePaths && nativePathDelta(body)) || (nativeSkillAuthoring && nativeSkillAuthoringDelta(body)) || (nativeMemoryWrites && nativeMemoryWritesDelta(body)) || (nativeSessionData && nativeSessionDataDelta(body, sessionDataFixture)) || (nativeDiscovery && nativeDiscoveryDelta(body)) || (nativeGoals && nativeGoalsDelta(body)) || (nativeDiagrams && nativeDiagramsDelta(body, nativeDiagramExport)) || (nativeMemoryPages && nativeMemoryPagesDelta(body, memoryPagesFixture)) || (nativeEditContext && nativeEditContextDelta(body)) || (nativeSemanticNeighbors && nativeSemanticNeighborsDelta(body)) || (nativeSymbolTools && nativeSymbolToolsDelta(body)) || (nativeFileTools && nativeFileToolsDelta(body)) || (nativeDirectory && nativeDirectoryDelta(body)) || (nativeModels && nativeModelsDelta(body)) || (nativeCosts && nativeCostsDelta(body)) || (nativeIndex && nativeIndexDelta(body, nativeRepoMap)) || (nativeLsp && nativeLspDelta(body)) || (nativeInspection && nativeInspectionDelta(body, inspectionFixture)) || (nativeDocs && nativeDocsDelta(body, docsFixture)) || (nativeWeb && nativeWebDelta(body, webFixture)) || (nativeApi && nativeApiDelta(body, apiFixture)) || (nativeHttp && nativeHttpDelta(body, httpFixture)) || (nativeOutput && nativeOutputDelta(body, toolMessages)) || (nativeDatabase && nativeDatabaseDelta(body, toolMessages)) || (nativeBrowser && nativeBrowserDelta(body, toolMessages, browserFixture)) || (nativePreview && nativePreviewDelta(body, toolMessages)) || (interactions && interactionDelta(body, toolMessages)) || (persistent && persistentCommandDelta(body, toolMessages, pty)) || (worktreeFollowup ? { role: 'assistant', content: 'HARNESS_WORKTREE_OK' } : mcpCase ? { role: 'assistant', tool_calls: [{ index: 0, id: native || toolMessages.length ? 'harness-mcp-mutate' : 'harness-mcp-discover', type: 'function',
      function: native || toolMessages.length ? { name: 'ext_harness-ext__mutate', arguments: '{}' }
        : { name: 'find_tools', arguments: JSON.stringify({ query: 'ext_harness-ext__mutate', limit: 1 }) } }] }
      : pausing && !toolMessages.length ? { role: 'assistant', tool_calls: [{ index: 0, id: 'harness-pause-1', type: 'function',
      function: { name: toolImages ? 'view_image' : 'read_file', arguments: JSON.stringify({ path: toolImages ? 'tool-image.png' : 'fixture.txt' }) } }] }
      : followup ? { role: 'assistant', content: 'HARNESS_FOLLOWUP_OK' } : toolMessages.length === 0 && writing
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'harness-write-1', type: 'function',
        function: commands ? { name: 'run_command', arguments: JSON.stringify({ command: 'node -',
          stdin: 'require("node:child_process").execFileSync("git",["init","--quiet"]);require("node:fs").writeFileSync("approved.txt","approved-once\\n");' }) }
          : { name: 'write_file', arguments: JSON.stringify({ path: 'approved.txt', content: 'approved-once\n' }) } },
        ...(commands ? [{ index: 1, id: 'harness-git-1', type: 'function', function: { name: 'git_status', arguments: '{}' } }] : [])] }
      : toolMessages.length === 0
      ? { role: 'assistant', tool_calls: [...readFixtures.map((path, index) => ({ index, id: `harness-read-${index + 1}`, type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path }) } })), ...(toolImages ? [{ index: 4, id: 'harness-view-1', type: 'function',
        function: { name: 'view_image', arguments: JSON.stringify({ path: 'tool-image.png' }) } }] : []),
        ...(search ? [{ index: 4 + Number(toolImages), id: 'harness-grep-1', type: 'function',
          function: { name: 'mcp__grep_code', arguments: JSON.stringify({ pattern: 'harness-file-content', literal: true, max_results: 8 }) } }] : []),
        ...knowledgeCalls.map(([id, name, input], index) => ({ index: 4 + Number(toolImages) + Number(search) + index,
          id: `harness-${id}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }))] }
      : { role: 'assistant', content: verificationReminder
        ? 'HARNESS_RESULT_OK. No project tests are configured for this text fixture.' : 'HARNESS_RESULT_OK' });
    const chunk = (value, finish_reason = null) => ({ id: 'local-completion', object: 'chat.completion.chunk',
      model: body.model, choices: [{ index: 0, delta: value, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerFailure = error;
    console.error('Harness provider failed:', error);
    if (response.headersSent) { response.destroy(error instanceof Error ? error : new Error(String(error))); return; }
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${server.address().port}/v1`;
const started = performance.now();
async function launchApplication(trace = true) {
  app = await electron.launch({ executablePath, cwd: repo, env, timeout: 90_000,
    args: [...(unpackaged ? [repo] : []), `--user-data-dir=${join(isolated, 'profile')}`, ...(startupTracePath && trace ? [
      '--trace-startup=toplevel,devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.cpu_profiler',
      '--trace-startup-duration=15', '--trace-startup-format=json',
      `--trace-startup-file=${startupTracePath}`,
    ] : [])] });
  app.process().stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-64 * 1024); });
  app.context().on('page', page => page.on('pageerror', error => report.errors.push(error.message)));
  dashboard = undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    dashboard = app.windows().find(page => /dashboard[\\/].*index\.html/.test(page.url()));
    if (dashboard) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(dashboard, `dashboard did not open; windows=${JSON.stringify(app.windows().map(page => page.url()))}`);
}
try {
  await launchApplication();
  console.log('Packaged dashboard opened');
  report.vectorExtensionVersion = await app.evaluate(async ({ app }) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const module = require(join(app.getAppPath(), 'dist/packages/store/src/sqlite-vec-store.js'));
    const database = new module.SqliteVecDatabase(':memory:');
    try { await database.loadExtension(); return database.db.prepare('SELECT vec_version() AS version').get().version; }
    finally { database.close(); }
  });
  const post = (path, body, method = 'POST') => dashboard.evaluate(async ({ path, body, method }) => {
    const response = await fetch(`mcp://app${path}`, { method,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path}: ${response.status}: ${text.slice(0, 1000)}`);
    return JSON.parse(text);
  }, { path, body, method });
const reopenApplication = async () => {
      const previous = await app.evaluate(({ app }) => app.getAppMetrics().map(m => m.pid));
      await app.close(); app = undefined;
      const alive = () => previous.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      for (let i = 0; i < 50 && alive().length; i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(alive(), [], 'legacy import startup left an Electron process');
      await launchApplication(false); return { app, dashboard };
    };
  await post('/api/admin/providers', { id: 'harness-local', name: 'Harness local fixture', kind: 'deepseek',
    base_url: providerUrl, api_key: 'local-fixture-not-a-secret', enabled: true, use_for_coder: true });
  await post('/api/admin/providers/harness-local/models', { model_id: 'harness-model', name: 'Harness model',
    mode: 'chat', context_window: 128_000 });
  const project = await post('/api/projects', { name: 'Harness fixture', root_path: projectRoot });
  report.projectId = project.id;
  if (knowledge) await app.evaluate(({ app }, projectId) => {
    const { join } = process.getBuiltinModule('node:path');
    const require = process.getBuiltinModule('node:module').createRequire(join(app.getAppPath(), 'package.json'));
    const { CodeIndexDB } = require(join(app.getAppPath(), 'dist/packages/store/src/db.js'));
    const { SkillStore } = require(join(app.getAppPath(), 'dist/packages/store/src/skill-store.js'));
    const db = new CodeIndexDB(process.env.MCP_INDEX_DB, { busyTimeoutMs: 500 });
    try {
      new SkillStore(db.raw()).upsertSkill({ id: 'harness-review', name: 'Harness review', source: 'user',
        prompt_body: 'HARNESS_SKILL_PROOF ${PROJECT_NAME}', scope: String(projectId), enabled: true, context_mode: 'both' });
      db.setProjectMemoryEnabled(projectId, true);
      db.createAgentMemory({ scope: 'project', projectId, name: 'harness-memory-convention', type: 'convention',
        content: 'HARNESS_MEMORY_PROOF: harness memory convention uses the project test script.', source: 'user', importance: 1 });
    } finally { db.close(); }
  }, project.id);
  if (existingProject) report.existingProject = await seedExistingProjectFixture(app, project.id);
  const session = await post('/api/coder/sessions', { project_id: project.id, title: 'Admission fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 });
  sessionId = session.id;
  report.sessionId = sessionId;
  console.log('Isolated project and provider configured');
  const runStarted = performance.now();
  if (native) {
    // Only this ephemeral test process receives a fake signed-in account.
    // Local coding is free; no cloud token, account or paid endpoint is used.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('cloud:auth-state');
      ipcMain.handle('cloud:auth-state', () => ({ state: 'logged_in',
        account: { id: 'harness-local', email: 'harness@example.invalid', name: 'Harness fixture' } }));
      ipcMain.removeHandler('cloud:fetch');
      ipcMain.handle('cloud:fetch', () => ({ ok: false, status: 503, body: { error: 'isolated_harness_offline' } }));
    });
    report.accountFixture = 'In-memory IPC fixture; no cloud authentication or entitlement certification';
    await dashboard.evaluate(() => {
      localStorage.setItem('mcp-ide:onboarded', 'true');
      localStorage.setItem('codestudio:preflight-done', 'true');
    });
    await dashboard.goto(dashboard.url().split('#')[0] + `#/projects/${project.id}?session=${sessionId}`);
    await dashboard.reload();
    const composer = dashboard.locator('textarea').last();
    await composer.waitFor({ state: 'visible', timeout: 60_000 });
    await dashboard.getByText('Harness local fixture · harness-model', { exact: true }).waitFor({ timeout: 60_000 });
    await composer.fill('Read fixture.txt, then finish. HARNESS_CASE' + (proactiveMemory ? ' Use our harness memory convention.' : ''));
    if (knowledge) {
      const stateButton = dashboard.getByRole('button', { name: 'Estado da sessão', exact: true });
      if (await stateButton.getAttribute('aria-pressed') !== 'true') await stateButton.click();
      const skillsButton = dashboard.getByRole('button', { name: 'Skills', exact: true });
      if (await skillsButton.getAttribute('aria-expanded') !== 'true') await skillsButton.click();
      await dashboard.getByPlaceholder('Buscar skills…', { exact: true }).fill('Harness review');
      await dashboard.getByRole('checkbox', { name: 'Harness review', exact: true }).check();
    }
    if (attachments) {
      await dashboard.locator('input[type="file"]').last().setInputFiles([
        join(isolated, 'attachment.png'), join(isolated, 'attachment.txt')]);
      await dashboard.getByText('attachment.txt', { exact: true }).waitFor();
    }
    console.log('Native composer ready');
    await dashboard.evaluate(sessionId => {
      const original = window.fetch.bind(window);
      window.harnessNativeStream = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('native composer stream timed out')), 120_000);
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (String(args[0]).includes(`/sessions/${sessionId}/messages`) && args[1]?.method === 'POST') {
            window.harnessSubmittedAttachments = JSON.parse(args[1].body).attachments;
            window.harnessSubmittedSkills = JSON.parse(args[1].body).selected_skill_ids;
            void response.clone().text().then(text => { clearTimeout(timer); resolve({ text, status: response.status }); }, reject);
          }
          return response;
        };
      });
    }, sessionId);
    await dashboard.getByRole('button', { name: 'Enviar', exact: true }).click({ timeout: 60_000 });
    const response = await dashboard.evaluate(() => window.harnessNativeStream);
    console.log('Native composer stream connected');
    report.stream = response.text;
    if (providerFailure) throw providerFailure;
    assert(response.status === 200, `native composer request returned ${response.status}`);
    report.composerSubmitted = true;
    if (knowledge) {
      assert.deepEqual(await dashboard.evaluate(() => window.harnessSubmittedSkills), ['harness-review']);
      report.selectedSkillComposerSubmitted = true;
    }
    if (attachments) {
      const submitted = await dashboard.evaluate(() => window.harnessSubmittedAttachments);
      assert(submitted.some(item => item.name === 'attachment.txt' && item.path && !item.text && !item.base64),
        'desktop did not use its real file-reference attachment path');
      report.attachmentFileReference = true;
    }
    const history = await dashboard.evaluate(async sessionId => {
      const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}?full=1`);
      if (!response.ok) throw new Error(`native history ${response.status}: ${await response.text()}`);
      return response.json();
    }, sessionId);
    assert.equal(history.messages[0]?.role, 'user');
    assert(JSON.stringify(history.messages[0]).includes('HARNESS_CASE'), 'native input missing after recovery');
    assert(JSON.stringify(history.messages.at(-1)).includes('HARNESS_RESULT_OK'), 'native final answer missing from history');
    assert.equal(history.messages.filter(message => message.role === 'tool').length, expectedToolCount);
    assert.equal(history.total_messages, history.messages.length, 'native count disagrees with projection');
    report.recoveredMessageCount = history.messages.length;
    if (knowledge) {
      assert.deepEqual(history.messages[0].selectedSkillIds, ['harness-review']);
      assert(!JSON.stringify(history.messages[0].content).includes('<active_skills>'), 'internal skill text leaked into visible history');
      report.selectedSkillHistoryRecovered = true;
    }
    if (toolImages) {
      assert(JSON.stringify(history.messages).includes(toolImage), 'journal lost the tool image');
      assert(report.stream.includes(`"image":{"mediaType":"image/png","base64":"${toolImage}"}`), 'live tool preview missing');
      // Overwriting the original proves the follow-up/restart use committed content.
      await writeFile(join(projectRoot, 'tool-image.png'), 'no longer an image');
      report.toolImageRecovered = true;
    }
    if (attachments) {
      assert(JSON.stringify(history.messages[0]).includes(attachmentImage), 'journal lost the attached image');
      assert(JSON.stringify(history.messages[0]).includes('HARNESS_DOCUMENT_CONTENT'), 'journal lost the document bytes');
      assert(JSON.stringify(history.messages[0]).includes('attachment.txt'), 'journal lost the document name');
      report.attachmentsRecovered = true;
    }
    await dashboard.reload();
    await dashboard.getByText('HARNESS_RESULT_OK', { exact: true }).waitFor({ timeout: 30_000 });
    if (toolImages) {
      // History deliberately strips base64; exercise the real lazy preview API.
      await dashboard.getByTitle('Load preview', { exact: true }).last().click();
      await dashboard.locator(`img[src="data:image/png;base64,${toolImage}"]`).first().waitFor({ state: 'attached', timeout: 30_000 });
      assert(await dashboard.locator(`img[src="data:image/png;base64,${toolImage}"]`).first().evaluate(image => image.complete
        ? image.naturalWidth > 0 : new Promise(resolve => { image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false); })),
        'tool preview image did not decode');
      await dashboard.getByAltText('attachment full size', { exact: true }).locator('..').click({ position: { x: 2, y: 2 } });
      report.toolImageRendered = true;
    }
    report.historySurvivedReload = true;
    await dashboard.screenshot({ path: join(output, 'native-chat.png') });
  } else report.stream = await dashboard.evaluate(async sessionId => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({ content: 'Read fixture.txt, then finish. HARNESS_CASE', profile: 'full',
        client_msg_id: 'harness-admission-one', max_turns: 3 }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`run ${response.status}: ${text.slice(0, 1000)}`);
    return text;
  }, sessionId);
  report.runMs = performance.now() - runStarted;
  if (existingProject) report.existingProject = await verifyExistingProjectFixture(app, report.existingProject);
  if (providerFailure) throw providerFailure;
  assert(!stderrTail.includes('already bound to a different runner'), 'runner lifecycle changed its admitted identity');
  assert(!stderrTail.includes('installDocsDeepResearch: failed to register'), 'DocsAgent attempted registration after sealing');
  assert(toolResponseSeen, 'the real file content did not reach the provider');
  assert(report.stream.includes('HARNESS_RESULT_OK'), 'final answer missing');
  assert(!/event: error\r?\n/.test(report.stream), 'stream contains a terminal error');
  assert.equal(report.requests.length, 2, 'unexpected provider retries or additional turns');
  if (proactiveMemory) assert(report.proactiveMemoryReceived, 'proactive memory did not reach a committed provider boundary');
  if (native) {
    if (attachments) {
      // The follow-up must recover committed bytes, not reread the original attachment.
      await writeFile(join(isolated, 'attachment.txt'), 'CHANGED_AFTER_FIRST_COMMAND');
    }
    const composer = dashboard.locator('textarea').last();
    await composer.fill('Continue this conversation. HARNESS_FOLLOWUP_CASE');
    await dashboard.evaluate(sessionId => {
      const original = window.fetch.bind(window);
      window.harnessNativeStream = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('native follow-up timed out')), 120_000);
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (String(args[0]).includes(`/sessions/${sessionId}/messages`) && args[1]?.method === 'POST') {
            void response.clone().text().then(text => { clearTimeout(timer); resolve({ text, status: response.status }); }, reject);
          }
          return response;
        };
      });
    }, sessionId);
    await dashboard.getByRole('button', { name: 'Enviar', exact: true }).click({ timeout: 60_000 });
    const result = await dashboard.evaluate(() => window.harnessNativeStream);
    if (providerFailure) throw providerFailure;
    assert.equal(result.status, 200);
    report.followupStream = result.text;
    assert(result.text.includes('HARNESS_FOLLOWUP_OK'), 'native follow-up did not complete');
    assert(!/event: error\r?\n/.test(result.text), 'follow-up contains a terminal error');
    assert.equal(report.requests.length, 3, 'follow-up replayed tools or retried provider');
    assert.notEqual(report.requests[2].admission.runtimeRoute.attemptId, report.requests[0].admission.runtimeRoute.attemptId);
    const history = await dashboard.evaluate(async sessionId =>
      (await fetch(`mcp://app/api/coder/sessions/${sessionId}?full=1`)).json(), sessionId);
    assert.equal(history.messages.length, report.recoveredMessageCount + 2, 'follow-up duplicated or lost transcript messages');
    assert(JSON.stringify(history.messages.at(-2)).includes('HARNESS_FOLLOWUP_CASE'));
    assert(JSON.stringify(history.messages.at(-1)).includes('HARNESS_FOLLOWUP_OK'));
    report.followupMessageCount = history.messages.length;
    await dashboard.reload();
    await dashboard.getByText('HARNESS_FOLLOWUP_OK', { exact: true }).waitFor({ timeout: 30_000 });
    report.followupSurvivedReload = true;
    await dashboard.screenshot({ path: join(output, 'native-followup.png') });
  }
  if (continuation) {
    if (toolImages) await writeFile(join(projectRoot, 'tool-image.png'), Buffer.from(toolImage, 'base64'));
    const requestsBeforePause = report.requests.length;
    const pausedSession = await post('/api/coder/sessions', { project_id: project.id, title: 'Native continuation fixture',
      provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 1, max_auto_continues: 0 });
    sessionId = pausedSession.id;
    const pauseStream = dashboard.evaluate(async sessionId => {
      const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ content: 'Read fixture.txt. HARNESS_PAUSE_CASE', profile: 'full',
          client_msg_id: 'harness-native-pause', max_turns: 1, max_auto_continues: 0 }) });
      const text = await response.text();
      if (!response.ok) throw new Error(`native pause ${response.status}: ${text.slice(0, 1000)}`);
      return text;
    }, sessionId);
    void pauseStream.catch(() => {});
    report.pausedStream = await pauseStream;
    assert(report.pausedStream.includes('max_turns'), 'native turn limit did not produce a resumable pause');
    assert.equal(report.requests.length, requestsBeforePause + 1, 'checkpoint opened an extra provider request');
    const pausedAdmission = report.requests.at(-1).admission;
    if (toolImages) await writeFile(join(projectRoot, 'tool-image.png'), 'changed after durable checkpoint');
    const requestsBeforeResume = report.requests.length;
    resumeAllowed = true;
    report.resumeStream = await dashboard.evaluate(async sessionId => {
      const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/continue`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ profile: 'full', client_msg_id: 'harness-native-continue', max_turns: 3 }) });
      const text = await response.text();
      if (!response.ok) throw new Error(`native continue ${response.status}: ${text.slice(0, 1000)}`);
      return text;
    }, sessionId);
    assert(report.resumeStream.includes('HARNESS_RESULT_OK'), 'native continuation did not complete');
    assert.equal(report.requests.length, requestsBeforeResume + 1, 'native continuation repeated a tool/provider turn');
    assert.notEqual(report.requests.at(-1).admission.runtimeRoute.attemptId, pausedAdmission.runtimeRoute.attemptId);
    const history = await dashboard.evaluate(async id => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`);
      if (!response.ok) throw new Error(`continuation history ${response.status}`);
      return response.json();
    }, sessionId);
    assert.equal(history.messages.length, toolImages ? 5 : 4, 'continuation duplicated history');
    assert.equal(history.messages.filter(message => message.role === 'user').length, toolImages ? 2 : 1);
    report.continuationHistoryCount = history.messages.length;
  }
  if (!native) {
  // Stop at a real tool frontier; /continue intentionally refuses a conversation
  // that has already completed with a final assistant answer.
  const pausedSession = await post('/api/coder/sessions', { project_id: project.id, title: 'Resume fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 1, max_auto_continues: 0 });
  sessionId = pausedSession.id;
  report.pausedStream = await dashboard.evaluate(async sessionId => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: 'Read fixture.txt. HARNESS_PAUSE_CASE', profile: 'full',
        client_msg_id: 'harness-pause-one', max_turns: 1, max_auto_continues: 0 }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`pause ${response.status}: ${text.slice(0, 1000)}`);
    return text;
  }, sessionId);
  assert.equal(report.requests.length, 3, 'paused run did not stop after one provider turn');
  const firstAttempt = report.requests[2].admission.runtimeRoute.attemptId;
  report.resumeStream = await dashboard.evaluate(async sessionId => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/continue`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ profile: 'full', client_msg_id: 'harness-resume-one', max_turns: 3 }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`resume ${response.status}: ${text.slice(0, 1000)}`);
    return text;
  }, sessionId);
  assert(report.resumeStream.includes('HARNESS_RESULT_OK'), 'continuation did not complete');
  assert.equal(report.requests.length, 4);
  assert.notEqual(report.requests[3].admission.runtimeRoute.attemptId, firstAttempt);
  }
  const requestsBeforeCancel = report.requests.length;
  const cancelledSession = await post('/api/coder/sessions', { project_id: project.id, title: 'Cancel fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 });
  sessionId = cancelledSession.id;
  const cancelStream = dashboard.evaluate(async sessionId => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: 'HARNESS_CANCEL_CASE', profile: 'full', client_msg_id: 'harness-cancel-one' }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`cancel run ${response.status}: ${text.slice(0, 1000)}`);
    return text;
  }, sessionId);
  void cancelStream.catch(() => {});
  let waitTimer;
  const cancellationAdmission = await Promise.race([cancelProviderStarted,
    new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error('cancel provider did not start')), 60_000); }),
  ]).finally(() => clearTimeout(waitTimer));
  if (cohort) {
    const requestsBeforeConflict = report.requests.length;
    report.crossProfileCohort = await probeOtherProfile(app, { projectRoot,
      generation: native ? 'legacy_ts' : 'rust_v1' });
    if (native) report.crossProfileNativeLease = await probeOtherProfile(app, { projectRoot,
      generation: 'rust_v1', nativeLease: true });
    await app.evaluate((_electron, nativeActive) => {
      if (nativeActive) delete process.env.CODESTUDIO_NATIVE_CODER_DEV;
      else process.env.CODESTUDIO_NATIVE_CODER_DEV = '1';
    }, native);
    try {
      const blocked = await post('/api/coder/sessions', { project_id: project.id, title: 'Cross-runtime conflict fixture',
        provider: 'harness-local', model: 'harness-model', agent: 'explore', max_turns: 3 });
      const conflict = await dashboard.evaluate(async id => {
        const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({ content: 'HARNESS_COHORT_CONFLICT', profile: 'full', client_msg_id: 'harness-cohort-conflict' }) });
        return { status: response.status, text: await response.text() };
      }, blocked.id);
      report.cohortConflict = conflict;
      assert.equal(conflict.status, 409, 'workspace conflict must be an explicit HTTP conflict');
      assert.equal(JSON.parse(conflict.text).code, 'WORKSPACE_RUNTIME_CONFLICT');
      assert(conflict.text.includes('Workspace belongs to another runtime generation'), 'the other runtime bypassed workspace ownership');
      assert.equal(report.requests.length, requestsBeforeConflict, 'conflicting runtime reached the provider');
      report.cohortEvidence = { active: native ? 'rust_v1' : 'legacy_ts', refused: native ? 'legacy_ts' : 'rust_v1',
        rejectedBeforeProvider: true, sessionId: blocked.id };
    } finally {
      await app.evaluate((_electron, nativeActive) => {
        if (nativeActive) process.env.CODESTUDIO_NATIVE_CODER_DEV = '1';
        else delete process.env.CODESTUDIO_NATIVE_CODER_DEV;
      }, native);
    }
  }
  const cancelStarted = performance.now();
  await post(`/api/coder/sessions/${sessionId}/abort`, {});
  report.cancelAckMs = performance.now() - cancelStarted;
  report.cancelStream = await cancelStream;
  report.cancelCompletionMs = performance.now() - cancelStarted;
  assert(native ? /"interrupted":true/.test(report.cancelStream) : /"reason":"aborted"/.test(report.cancelStream), 'cancellation did not terminate the runner as interrupted');
  const controlFiles = (await readdir(isolated, { recursive: true }))
    .filter(path => /events[\\/]runtime-requests[\\/][^\\/]+\.json$/.test(path));
  const controls = await Promise.all(controlFiles.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8'))));
  assert(controls.some(record => record.data.key === 'cancel'
    && record.relations.attempt === cancellationAdmission.runtimeRoute.attemptId), 'durable facade cancellation missing');
  assert(cancelProviderClosed, 'provider connection remained open after cancellation');
  report.cancelProviderClosed = cancelProviderClosed;
  assert.equal(report.requests.length, requestsBeforeCancel + 1, 'cancel retried a provider request');
  if (!native || filesystem) {
  const requestsBeforeApproval = report.requests.length;
  const approvalSession = await post('/api/coder/sessions', { project_id: project.id, title: 'Approval fixture',
    provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 3 });
  sessionId = approvalSession.id;
  const approvalRoot = worktree ? join(projectRoot, '.mcp-indexer', 'worktrees', 'native-packaged') : projectRoot;
  await post(`/api/coder/sessions/${sessionId}/tool-permission-mode`, { mode: 'ask' }, 'PATCH');
  await dashboard.exposeFunction('harnessBeforeApproval', async () => {
    await assert.rejects(readFile(join(projectRoot, 'approved.txt')), { code: 'ENOENT' }, 'write happened before approval');
    if (worktree) await assert.rejects(readFile(join(approvalRoot, 'approved.txt')), { code: 'ENOENT' }, 'worktree write happened before approval');
  });
  const approvedResult = await dashboard.evaluate(async ({ sessionId, native, worktree }) => {
    const response = await fetch(`mcp://app/api/coder/sessions/${sessionId}/messages`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ content: 'Write approved.txt. HARNESS_APPROVAL_CASE', profile: 'full',
        client_msg_id: 'harness-approval-one', max_turns: 3,
        ...(worktree ? { worktree: { name: 'native-packaged', branch: 'codex/native-packaged' } } : {}) }) });
    if (!response.ok || !response.body) throw new Error(`approval run ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    let buffer = '';
    let approvals = 0;
    let approvedToolUseId;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = decoder.decode(next.value, { stream: true });
      stream += chunk;
      buffer += chunk;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!/^event: tool_approval_request$/m.test(frame)) continue;
        const data = JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n'));
        if ((native ? !/^native-tool:[a-f0-9]{64}$/.test(data.toolUseId) : data.toolUseId !== 'harness-write-1')
          || ++approvals !== 1) throw new Error('unexpected approval request');
        approvedToolUseId = data.toolUseId;
        await window.harnessBeforeApproval();
        const approval = await fetch(`mcp://app/api/coder/sessions/${sessionId}/tool-approval`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_use_id: data.toolUseId, approved: true }),
        });
        if (!approval.ok) throw new Error(`approval ${approval.status}: ${await approval.text()}`);
      }
    }
    if (approvals !== 1) throw new Error('write did not request permission');
    return { stream, approvedToolUseId };
  }, { sessionId, native, worktree });
  report.approvalStream = approvedResult.stream;
  report.approvedToolUseId = approvedResult.approvedToolUseId;
  assert.equal(await readFile(join(approvalRoot, 'approved.txt'), 'utf8'), 'approved-once\n');
  assert(report.approvalStream.includes('HARNESS_RESULT_OK'));
  const requestFiles = (await readdir(isolated, { recursive: true }))
    .filter(path => /events[\\/]runtime-requests[\\/][^\\/]+\.json$/.test(path));
  const requestRecords = await Promise.all(requestFiles.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8'))));
  assert(requestRecords.some(record => record.relations.session === sessionId
    && record.data.key.includes('interaction:') && record.data.key.endsWith(approvedResult.approvedToolUseId)), 'facade approval receipt missing');
  // Build's existing verification gate deliberately adds one reminder after
  // a write. It must not be mistaken for a retried write/provider transport.
  assert.equal(report.requests.length, requestsBeforeApproval + (native ? 2 : 3), 'unexpected calls in approved write');
  assert.equal(report.requests.filter(request => request.verificationReminder).length, native ? 0 : 1);
  if (worktree) {
    await assert.rejects(readFile(join(projectRoot, 'approved.txt')), { code: 'ENOENT' }, 'worktree mutation escaped to the original root');
    const data = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?tail=1`)).json(), sessionId);
    assert.equal(resolve(data.session.worktree_path), approvalRoot);
    const before = report.requests.length;
    const next = await dashboard.evaluate(async id => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}/messages`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ content: 'HARNESS_WORKTREE_FOLLOWUP', client_msg_id: 'worktree-followup', profile: 'full' }) });
      return { status: response.status, text: await response.text() };
    }, sessionId);
    assert.equal(next.status, 200); assert(next.text.includes('HARNESS_WORKTREE_OK'));
    assert.equal(report.requests.length, before + 1, 'reopened worktree replayed a provider or write');
    report.worktreeEvidence = { sessionId, root: approvalRoot, persisted: true, originalUnchanged: true, reopened: true };
  }
  }
  if (persistent) report.persistentCommands = await runPersistentCommandFixture({ root: projectRoot, dashboard, post, projectId: project.id,
    setSession: id => { sessionId = id; }, requestCount: () => report.requests.length, tty: pty });
  if (interactions) report.interactiveReviews = await runInteractionFixture({ dashboard, post, projectId: project.id, root: projectRoot,
    setSession: id => { sessionId = id; }, requestCount: () => report.requests.length });
  if (nativePreview) report.nativePreview = await runNativePreviewFixture({ app, dashboard, post, projectId: project.id, root: projectRoot,
      setSession: id => { sessionId = id; } });
  if (nativeBrowser) {
    browserFixture = await startNativeBrowserFixture(isolated);
    report.nativeBrowser = await runNativeBrowserFixture({ app, dashboard, post, projectId: project.id, root: projectRoot,
      fixture: browserFixture, setSession: id => { sessionId = id; } });
  }
  if (nativeDatabase) {
    databaseFixture = await startNativeDatabaseFixture(isolated);
    report.nativeDatabase = await runNativeDatabaseFixture({ app, dashboard, post, root: projectRoot,
      fixture: databaseFixture, setSession: id => { sessionId = id; } });
  }
  if (nativeOutput) report.nativeOutput = await runNativeOutputFixture({ dashboard, post, root: projectRoot,
    setSession: id => { sessionId = id; } });
  if (nativeHttp) {
    httpFixture = await startNativeHttpFixture();
    report.nativeHttp = await runNativeHttpFixture({ dashboard, post, root: projectRoot,
      fixture: httpFixture, setSession: id => { sessionId = id; } });
  }
  if (nativeDocs) {
    report.nativeDocs = await runNativeDocsFixture({ app, dashboard, post, root: projectRoot,
      fixture: docsFixture, setSession: id => { sessionId = id; } });
  }
  if (nativeInspection) report.nativeInspection = await runNativeInspectionFixture({ dashboard, post, root: projectRoot,
    fixture: inspectionFixture, setSession: id => { sessionId = id; } });
  if (nativeLsp) report.nativeLsp = await runNativeLspFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeIndex) report.nativeIndex = await runNativeIndexFixture({ app, dashboard, post, repoMap: nativeRepoMap, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeCosts) report.nativeCosts = await runNativeCostsFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeExport) report.nativeExport = await runNativeExportFixture({ app, dashboard, post, root: projectRoot, isolated, setSession: id => { sessionId = id; } });
  if (nativeIndexMutation) report.nativeIndexMutation = await runNativeIndexMutationFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeAgentReads) report.nativeAgentReads = await runNativeAgentReadsFixture({ dashboard, post, root: projectRoot, projectId: project.id, setSession: id => { sessionId = id; }, fixture: agentReadsFixture });
  if (process.argv.includes('--semantic-jobs')) report.semanticProjectJobs = await runSemanticProjectJobsFixture({ app, dashboard, post, root: projectRoot });
  if (nativeModels) report.nativeModels = await runNativeModelsFixture({ app, dashboard, post, projectId: project.id, setSession: id => { sessionId = id; } });
  if (nativeDirectory) report.nativeDirectory = await runNativeDirectoryFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeMemoryPages) report.nativeMemoryPages = await runNativeMemoryPagesFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; }, setFixture: value => { memoryPagesFixture = value; } });
  if (nativeMemoryWrites) report.nativeMemoryWrites = await runNativeMemoryWritesFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeSkillAuthoring) report.nativeSkillAuthoring = await runNativeSkillAuthoringFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeScripts) report.nativeScripts = await runNativeCodeExecFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; }, fixture: scriptFixture });
  if (nativeSpecs) report.nativeSpecs = await runNativeSpecFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeSpecs && process.argv.includes('--spec-ui')) report.nativeSpecUi = await runNativeSpecUiFixture({ dashboard, post, root: projectRoot, output, setSession: id => { sessionId = id; } });
  if (nativeTree) report.nativeTree = await runNativeTreeFixture({ dashboard, post, root: projectRoot, isolated, setSession: id => { sessionId = id; } });
  if (nativeWorkflow) report.nativeWorkflow = await runNativeWorkflowFixture({ dashboard, post, root: projectRoot, isolated, fixture: workflowFixture, setSession: id => { sessionId = id; } });
  if (nativeExecuteTasks) report.nativeExecuteTasks = await runNativeExecuteTasksFixture({ dashboard, post, root: projectRoot, isolated, fixture: executeTasksFixture, setSession: id => { sessionId = id; } });
  if (nativeSelfReview) report.nativeSelfReview = await runNativeSelfReviewFixture({ app, dashboard, post, root: projectRoot, fixture: selfReviewFixture, setSession: id => { sessionId = id; } });
  if (nativeTaskComplete) report.nativeTaskComplete = await runNativeTaskCompleteFixture({ app, dashboard, post, root: projectRoot,
    setSession: id => { sessionId = id; }, reopenApplication });
  if (nativeTasks) {
    report.nativeTasks = await runNativeTasksFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
    if (!restart) report.nativeTasks.followup = await recoverNativeTasksFixture({ dashboard, evidence: report.nativeTasks, setSession: id => { sessionId = id; } });
  }
  if (nativePaths) report.nativePaths = await runNativePathFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeDiagrams) report.nativeDiagrams = await runNativeDiagramsFixture({ app, root: projectRoot, dashboard, post, exports: nativeDiagramExport, setSession: id => { sessionId = id; } });
  if (nativeGoals) {
    report.nativeGoals = await runNativeGoalsFixture({ dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
    if (!restart) report.nativeGoals.followup = await finishNativeGoalsFixture({ dashboard, evidence: report.nativeGoals, setSession: id => { sessionId = id; } });
  }
  if (nativeDiscovery) report.nativeDiscovery = await runNativeDiscoveryFixture({ dashboard, post, projectId: project.id, setSession: id => { sessionId = id; } });
  if (nativeSessionData) report.nativeSessionData = await runNativeSessionDataFixture({ app, dashboard, post, root: projectRoot,
    setSession: id => { sessionId = id; }, setFixture: value => { sessionDataFixture = value; },
    reopenApplication });
  if (nativeEditContext) report.nativeEditContext = await runNativeEditContextFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeSemanticNeighbors) report.nativeSemanticNeighbors = await runNativeSemanticNeighborsFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeSymbolTools) report.nativeSymbolTools = await runNativeSymbolToolsFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeFileTools) report.nativeFileTools = await runNativeFileToolsFixture({ app, dashboard, post, root: projectRoot, setSession: id => { sessionId = id; } });
  if (nativeWeb) {
    webFixture = await startNativeWebFixture(isolated);
    report.nativeWeb = await runNativeWebFixture({ app, dashboard, post, root: projectRoot,
      fixture: webFixture, setSession: id => { sessionId = id; } });
  }
  if (nativeApi) {
    apiFixture = await startNativeApiFixture();
    report.nativeApi = await runNativeApiFixture({ app, dashboard, post, root: projectRoot,
      fixture: apiFixture, setSession: id => { sessionId = id; } });
  }
  if (preparationStop) report.preparationStop = await runPreparationStopFixture({ app, dashboard, post, projectId: project.id,
    setSession: id => { sessionId = id; }, requestCount: () => report.requests.length });
  if (publicMcp) {
    report.publicMcpRuns = await runPublicMcpFixture({ port: publicMcpPort,
      setSession: id => { sessionId = id; }, requests: report.requests, cancelObserved: () => publicMcpCancelStarted });
    assert(publicMcpCancelClosed, 'public MCP cancellation left the provider stream open');
  }
  if (cli) {
    const approval = await post('/api/coder/sessions', { project_id: project.id, title: 'CLI approval fixture',
      provider: 'harness-local', model: 'harness-model', agent: 'build', max_turns: 8 });
    await post(`/api/coder/sessions/${approval.id}/tool-permission-mode`, { mode: 'ask' }, 'PATCH');
    await app.close(); app = undefined;
    report.cli = await runCliFixture({ env, repo, isolated, approvalSessionId: approval.id,
      ...(!unpackaged ? { packaged: true, executablePath,
        entryPoint: join(dirname(executablePath), 'resources', 'app.asar', 'dist', 'apps', 'cli', 'index.js') } : {}),
      setSession: id => { sessionId = id; }, requests: report.requests, cancelObserved: () => cliCancelStarted });
    await launchApplication(false);
  }
  if (nativeWorktreeTools) report.nativeWorktreeTools = await runNativeWorktreeToolsFixture({ dashboard, post, root: projectRoot,
    setSession: id => { sessionId = id; }, reopenApplication,
    requestCount: () => report.requests.length, requestsSince: count => report.requests.slice(count) });
  // The lost-ACK fixture deliberately retains the workspace lease. Run it last:
  // later commands must not bypass that unresolved-effect fence to pass a test.
  if (mcpFixture) report.externalMcp = await runMcpFixture({ dashboard, post, projectId: project.id, fixture: mcpFixture,
    setSession: id => { sessionId = id; }, requestCount: () => report.requests.length, native, worktree });
  if (restart) {
    const providerCallsBeforeRestart = report.requests.length;
    const previousPids = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid));
    await app.close();
    app = undefined;
    const alive = () => previousPids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    for (let check = 0; check < 50 && alive().length; check++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(alive(), [], 'first application left a process alive before restart');
    report.preRestartProcesses = previousPids;
    delete env.CODESTUDIO_NATIVE_CODER_DEV;
    await launchApplication(false);
    if (publicMcp) report.publicMcpRestart = await assertPublicMcpAfterRestart(publicMcpPort, report.publicMcpRuns);
    const history = await dashboard.evaluate(async id => {
      const response = await fetch(`mcp://app/api/coder/sessions/${id}?full=1`);
      if (!response.ok) throw new Error(`restart history ${response.status}`);
      return response.json();
    }, report.sessionId);
    assert.equal(history.messages.length, report.followupMessageCount, 'restart lost transcript');
    assert(JSON.stringify(history.messages).includes('HARNESS_FOLLOWUP_OK'));
    report.restartHistoryQueries = await assertHistoryQueries(dashboard, report.sessionId, history);
    if (attachments) assert(JSON.stringify(history.messages).includes('HARNESS_DOCUMENT_CONTENT'));
    if (toolImages) assert(JSON.stringify(history.messages).includes(toolImage), 'restart lost the tool image');
    if (worktree) {
      const treeHistory = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), report.worktreeEvidence.sessionId);
      assert.equal(resolve(treeHistory.session.worktree_path), report.worktreeEvidence.root);
      assert(JSON.stringify(treeHistory.messages).includes('HARNESS_WORKTREE_OK'));
      report.worktreeEvidence.restartRecovered = true;
    }
    if (persistent) {
      const commandHistory = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), report.persistentCommands.sessionId);
      assert(JSON.stringify(commandHistory.messages).includes('HARNESS_PERSISTENT_COMPLETE'));
      report.persistentCommands.restartRecovered = true;
    }
      if (nativePreview) {
        const completed = report.nativePreview.cases.find(item => item.scenario === 'COMPLETE');
        const history = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), completed.sessionId);
        assert(JSON.stringify(history.messages).includes('HARNESS_NATIVE_PREVIEW_OK'), 'restart lost native preview history');
        report.nativePreview.restartRecovered = true;
        const uncertain = report.nativePreview.cases.find(item => item.scenario === 'UNKNOWN');
        report.nativePreview.uncertaintyRecovery = await assertNativePreviewRecovery(dashboard, uncertain.sessionId, uncertain.root);
      }
    if (mcpFixture) report.externalMcp.restartRecovery = await assertMcpRecovery({ dashboard,
      sessionId: report.externalMcp.sessionId, fixture: mcpFixture, requestCount: () => report.requests.length });
    if (nativeBrowser) {
      const completed = report.nativeBrowser.cases.find(item => item.scenario === 'COMPLETE');
      const history = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), completed.sessionId);
      assert(JSON.stringify(history.messages).includes('HARNESS_NATIVE_BROWSER_OK'), 'restart lost browser history');
      const uncertain = report.nativeBrowser.cases.find(item => item.scenario === 'UNKNOWN');
      report.nativeBrowser.restartRecovery = await assertNativeBrowserRecovery(dashboard, uncertain.sessionId);
    }
    if (nativeDatabase) {
      const completed = report.nativeDatabase.cases.find(item => item.scenario === 'COMPLETE');
      const history = await dashboard.evaluate(async id => (await fetch(`mcp://app/api/coder/sessions/${id}?full=1`)).json(), completed.sessionId);
      assert(JSON.stringify(history.messages).includes('HARNESS_NATIVE_DATABASE_OK'), 'restart lost database history');
      const uncertain = report.nativeDatabase.cases.find(item => item.scenario === 'UNKNOWN');
      report.nativeDatabase.restartRecovery = await assertNativeDatabaseRecovery(dashboard, uncertain.sessionId);
    }
    if (nativeHttp) {
      const uncertain = report.nativeHttp.cases.find(item => item.scenario === 'UNKNOWN');
      report.nativeHttp.restartRecovery = await assertNativeHttpRecovery(dashboard, uncertain.sessionId);
      assert.equal(httpFixture.effects(), 1);
    }
    if (nativeApi) {
      const uncertain = report.nativeApi.cases.find(item => item.scenario === 'UNKNOWN');
      report.nativeApi.restartRecovery = await assertNativeApiRecovery(dashboard, uncertain.sessionId);
      assert.equal(apiFixture.effects(), 1);
    }
    const expectedAttempts = new Set(report.requests.map(request => request.admission.runtimeRoute.attemptId));
    let recovered = [];
    const recoveryDeadline = Date.now() + 30_000;
    while (Date.now() < recoveryDeadline) {
      const records = (await readdir(isolated, { recursive: true }))
        .filter(path => /checkpoints[\\/]control-plane[\\/][^\\/]+\.json$/.test(path));
      recovered = (await Promise.all(records.map(async path => JSON.parse(await readFile(join(isolated, path), 'utf8')))))
        .filter(record => record.data.checkpointType === 'native-supervisor-recovery-v1');
      if ([...expectedAttempts].every(id => recovered.some(record => record.relations.attempt === id))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert([...expectedAttempts].every(id => recovered.some(record => record.relations.attempt === id)), 'startup did not reconcile all native cleanup evidence');
    assert(recovered.every(record => record.data.hostEffectsReconciled === false), 'physical cleanup incorrectly released Host effects');
    assert.equal(report.requests.length, providerCallsBeforeRestart, 'restart replayed a provider operation');
    report.restartRecovery = { nativeDevelopmentFlag: false, attempts: [...expectedAttempts],
      recoveredCheckpoints: recovered.length, historyMessageCount: history.messages.length, replayedProviderCalls: 0 };
    if (nativeTree) report.nativeTree.afterRestart = await recoverNativeTreeFixture({ dashboard, evidence: report.nativeTree });
    if (nativeExecuteTasks) { await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeExecuteTasks.afterRestart = await recoverNativeExecuteTasksFixture({ dashboard, evidence: report.nativeExecuteTasks, fixture: executeTasksFixture, setSession: id => { sessionId = id; } }); }
    if (nativeWorkflow) { await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeWorkflow.afterRestart = await recoverNativeWorkflowFixture({ dashboard, evidence: report.nativeWorkflow, fixture: workflowFixture, setSession: id => { sessionId = id; } }); }
    if (nativeSelfReview) report.nativeSelfReview.afterRestart = await recoverNativeSelfReviewFixture({ dashboard, evidence: report.nativeSelfReview });
    if (nativeTaskComplete) report.nativeTaskComplete.afterRestart = await recoverNativeTaskCompleteFixture({ dashboard, evidence: report.nativeTaskComplete });
    if (nativeExport) { await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; }); report.nativeExport.followup = await recoverNativeExportFixture({ dashboard, evidence: report.nativeExport, setSession: id => { sessionId = id; } }); }
    if (nativeIndexMutation) { await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; }); report.nativeIndexMutation.followup = await recoverNativeIndexMutationFixture({ dashboard, evidence: report.nativeIndexMutation, setSession: id => { sessionId = id; } }); }
    if (nativeScripts) report.nativeScripts.followup = await recoverNativeCodeExecFixture({ dashboard, evidence: report.nativeScripts, setSession: id => { sessionId = id; },
      beforeSend: () => app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; }) });
    if (nativeSpecs) report.nativeSpecs.followup = await recoverNativeSpecFixture({ dashboard, evidence: report.nativeSpecs, setSession: id => { sessionId = id; },
      beforeSend: () => app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; }) });
    if (nativeTasks) report.nativeTasks.followup = await recoverNativeTasksFixture({ dashboard, evidence: report.nativeTasks,
      setSession: id => { sessionId = id; }, beforeSend: () => app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; }) });
    if (nativePaths) { await assertNativePathFiles(report.nativePaths); report.nativePaths.restartPreserved = true; }
    if (nativeSkillAuthoring) {
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeSkillAuthoring.followup = await recoverNativeSkillAuthoringFixture({ app, dashboard, evidence: report.nativeSkillAuthoring, setSession: id => { sessionId = id; } });
    }
    if (nativeMemoryWrites) {
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeMemoryWrites.followup = await recoverNativeMemoryWritesFixture({ app, dashboard, evidence: report.nativeMemoryWrites, setSession: id => { sessionId = id; } });
    }
    if (nativeGoals) {
      await assertNativeGoal(dashboard, report.nativeGoals, 'in_progress');
      report.nativeGoals.restartRecovered = true;
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeGoals.followup = await finishNativeGoalsFixture({ dashboard, evidence: report.nativeGoals, setSession: id => { sessionId = id; } });
    }
    if (nativeAgentReads) {
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeAgentReads.afterRestart = await runNativeAgentReadsFixture({ dashboard, post, projectId: project.id, setSession: id => { sessionId = id; }, fixture: agentReadsFixture, restored: true });
    }
    if (nativeSessionData) {
      await assertNativeSessionNotes(dashboard, report.nativeSessionData);
      report.nativeSessionData.restartRecovered = true;
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeSessionData.followup = await recoverNativeSessionDataFixture({ dashboard, evidence: report.nativeSessionData,
        setSession: id => { sessionId = id; } });
    }
    if (nativeOutput) {
      // History recovery above must work with rollout disabled. Executing a new
      // Rust attempt still requires the explicit development opt-in.
      await app.evaluate(() => { process.env.CODESTUDIO_NATIVE_CODER_DEV = '1'; });
      report.nativeOutput.afterRestart = await recoverNativeOutputFixture({ dashboard,
        evidence: report.nativeOutput, setSession: id => { sessionId = id; } });
      report.nativeOutput.resumedWithExplicitNativeOptIn = true;
    }
  }
  if (providerFailure) throw providerFailure;
  assert(!stderrTail.includes('already bound to a different runner'), 'runner lifecycle changed its admitted identity');
  assert(!stderrTail.includes('installDocsDeepResearch: failed to register'), 'DocsAgent attempted registration after sealing');
  if (cohort) assert(!stderrTail.includes('command terminalization failed'), 'startup conflict overwrote an owned terminal command');
  assert.deepEqual(report.errors, []);
  if (!native && process.argv.includes('--legacy-worktree')) report.legacyWorktree = await runLegacyWorktreeFixture({
    dashboard, post, root: projectRoot, setSession: id => { sessionId = id; }, requestCount: () => report.requests.length,
    requestsSince: count => report.requests.slice(count) });
  if (providerFailure) throw providerFailure;
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  report.failureStack = error instanceof Error ? error.stack : undefined;
  if (providerFailure) report.providerFailure = String(providerFailure);
  report.stderrTail = stderrTail;
  if (dashboard) {
    report.dashboardUrl = dashboard.url();
    await dashboard.screenshot({ path: join(output, 'failure.png'), timeout: 5_000 }).catch(() => {});
    report.visibleText = await dashboard.locator('body').innerText({ timeout: 5_000 }).catch(() => 'unavailable');
  }
  process.exitCode = 1;
} finally {
  if (app) {
    const pids = await app.evaluate(({ app }) => app.getAppMetrics().map(metric => metric.pid)).catch(() => []);
    await app.close();
    if (startupTracePath) {
      try {
        const trace = JSON.parse(await readFile(startupTracePath, 'utf8'));
        const events = trace.traceEvents ?? [];
        const processes = new Map(events.filter(event => event.ph === 'M' && event.name === 'process_name')
          .map(event => [event.pid, event.args?.name]));
        const threads = new Map(events.filter(event => event.ph === 'M' && event.name === 'thread_name')
          .map(event => [`${event.pid}:${event.tid}`, event.args?.name]));
        report.startupTrace = { path: startupTracePath, events: events.length,
          longestTasks: events.filter(event => event.ph === 'X' && /RunTask$/.test(event.name) && event.dur >= 50_000)
            .sort((left, right) => right.dur - left.dur).slice(0, 15)
            .map(event => ({ pid: event.pid, tid: event.tid, process: processes.get(event.pid),
              thread: threads.get(`${event.pid}:${event.tid}`), durationMs: event.dur / 1_000 })) };
      } catch (error) {
        report.startupTrace = { path: startupTracePath, error: String(error) };
        report.passed = false; report.failure ??= 'startup trace was not captured'; process.exitCode = 1;
      }
    }
    const alive = () => pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    for (let check = 0; check < 20 && alive().length; check++) await new Promise(resolve => setTimeout(resolve, 100));
    report.trackedElectronProcesses = pids;
    report.trackedElectronProcessesStillAlive = alive();
    if (report.trackedElectronProcessesStillAlive.length) {
      report.passed = false;
      report.failure ??= 'tracked Electron processes survived app.close';
      process.exitCode = 1;
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  try { report.externalMcpCleanup = await mcpFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  try { report.nativeBrowserCleanup = await browserFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  try { await databaseFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  try { await httpFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  try { await webFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  try { await apiFixture?.close(); }
  catch (error) { report.passed = false; report.failure ??= String(error); process.exitCode = 1; }
  report.elapsedMs = performance.now() - started;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const summary = { ...report };
  for (const key of ['stream', 'pausedStream', 'resumeStream', 'followupStream', 'cancelStream', 'approvalStream']) if (summary[key]) summary[key] = `${summary[key].length} characters; see report.json`;
  summary.requests = report.requests.map(request => ({ ...request, admission: { ...request.admission,
    runtimeRoute: { runtimeGeneration: request.admission.runtimeRoute.runtimeGeneration, attemptId: request.admission.runtimeRoute.attemptId } } }));
  console.log(JSON.stringify(summary, null, 2));
}


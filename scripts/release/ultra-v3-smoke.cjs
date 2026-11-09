/** Exercise the shipped Ultra modules, without a provider or the user's profile.
 * ELECTRON_RUN_AS_NODE=1 CodeStudio.exe ultra-v3-smoke.cjs <resources> <output>
 */
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const resources = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));
process.env.MCP_DATA_DIR = profile;
process.env.MCP_INDEX_DB = join(profile, 'index.db');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(profile, 'coordination');
const load = name => require(join(resources, 'app.asar', 'dist', 'packages', name));
const report = { schemaVersion: 1, resources, profile, checks: [], passed: false };
let finished = false;
process.once('beforeExit', () => { if (!finished) process.exitCode = 1; });

async function main() {
  const { resolveUltraPreset } = load('code-agent/src/sessions/ultra-policy.js');
  const policy = resolveUltraPreset({ enabled: true, effort: 'high', maxParallel: 1 });
  assert.equal(policy.effective.reasoning.effort, 'high');
  assert.equal(policy.effective.parallelism.maxAgents, 1);
  report.checks.push('requested effort and effective parallelism');

  const { ChatCollaborationStore } = load('session-storage/src/collaboration/store.js');
  const { CollaborationBudget } = load('session-storage/src/collaboration/budget.js');
  const store = new ChatCollaborationStore(profile);
  await store.init();
  await store.registerRoot('a', 'A'); await store.registerRoot('b', 'B');
  await store.linkSessions('a', 'b', true);
  const limits = { maxParallel: 1, maxStarts: 3 };
  const budget = new CollaborationBudget(store.files, 'root', limits);
  const second = new CollaborationBudget(store.files, 'root', limits);
  const slots = await Promise.allSettled([budget.reserve('one', 'a'), second.reserve('two', 'b')]);
  assert.equal(slots.filter(row => row.status === 'fulfilled').length, 1);
  const id = Object.keys((await budget.state()).reservations)[0];
  await budget.settle(id, 12, null, true);
  const recovered = new CollaborationBudget(store.files, 'root', limits);
  await assert.rejects(recovered.reserve('three', 'b'), /effect_unknown/);
  assert.equal((await recovered.state()).reservations[id].cost, null);
  report.checks.push('atomic budget admission and uncertain reservation after restart');

  const message = await store.send({ from: 'chat:a', to: 'chat:b', kind: 'question', body: 'Result?', idempotencyKey: 'question' });
  const abort = new AbortController(); abort.abort();
  assert.equal((await store.waitResult('chat:a', message.id, 1000, abort.signal)).reason, 'aborted');
  assert.equal((await store.get(message.id)).status, 'queued');
  await store.recordCompletion({ sessionId: 'a', runId: 'first', at: 2, reason: 'completed' });
  await store.recordCompletion({ sessionId: 'a', runId: 'second', at: 1, reason: 'error' });
  assert.deepEqual((await store.completions('a')).map(row => row.runId), ['first', 'second']);
  await store.stopSession('b'); await store.registerRoot('b', 'B');
  assert.equal(await store.currentGeneration(message), false);
  report.checks.push('wait abort, ordered completion journal and stop fencing');

  const { CollaborationFollowups } = load('session-storage/src/collaboration/followups.js');
  const followups = new CollaborationFollowups(store.files);
  const proposalInput = { sessionId: 'a', title: 'Follow-up', prompt: 'Inspect later', rationale: 'Optional', sourceRevision: 1, context: 'fresh' };
  const proposal = await followups.propose(proposalInput, 'proposal');
  assert.equal((await followups.propose(proposalInput, 'proposal')).id, proposal.id);
  const claim = await followups.claim(proposal.id, 'a', 'new', 'claim', proposal.revision);
  assert.equal((await followups.claim(proposal.id, 'a', 'new', 'claim', proposal.revision)).revision, claim.revision);
  assert.equal(claim.state, 'claimed');
  report.checks.push('idempotent proposal and claim without execution');

  const { ChatScheduler } = load('code-agent/src/runtime/chat-scheduler.js');
  let now = Date.parse('2026-01-01T12:00:00Z');
  const input = { kind: 'once', at: now + 1000, timezone: 'UTC', action: 'notify', prompt: 'Reminder', misfire: 'fire_once', overlap: 'skip', maxRuns: 1 };
  const scheduler = new ChatScheduler(store, () => now);
  await scheduler.create('a', input, 'allowed', true);
  const draft = await scheduler.create('a', input, 'draft', false);
  assert.equal(draft.state, 'needs_input');
  now += 600000;
  await Promise.all([scheduler.tick(), new ChatScheduler(store, () => now).tick()]);
  await scheduler.tick();
  assert.equal((await scheduler.records.list('occurrences')).length, 1);
  report.checks.push('scheduler restart and unauthorized timer stays inactive');

  const { requiredWorkResult } = load('code-agent/src/runtime/work-result.js');
  assert.equal(requiredWorkResult('done!', [], ['Tests pass']).acceptance, 'rejected');
  report.checks.push('unsupported success is rejected');

  const { ToolRegistry } = load('code-agent/src/core/registry.js');
  const { ToolCallLedger } = load('code-agent/src/core/tool-call-ledger.js');
  const { unknownToolOutcome } = load('code-agent/src/core/tool.js');
  const { buildCodeExecTool } = load('code-agent/src/tools/code-exec.js');
  const batchRegistry = new ToolRegistry(); const batchLedger = new ToolCallLedger();
  let cancelledRunningCommand = false;
  batchRegistry.register({ name: 'run_command', description: 'Diagnostic fixture', source: 'native',
    parameters: { type: 'object', properties: { step: { type: 'number' } } },
    mutates: false, parallelSafe: false, riskLevel: 'execute', timeoutMs: 7000,
    handler: async (args, ctx) => {
      ctx.signal.addEventListener('abort', () => { cancelledRunningCommand = true; }, { once: true });
      await new Promise(resolve => setTimeout(resolve, args.step === 1 ? 10 : 5200));
      return args.step === 1 ? { isError: true, content: 'exit code: 1; optional engine missing' } : { content: 'diagnostic completed' };
    } });
  const batch = await buildCodeExecTool(batchRegistry).handler({ code:
    'return await Promise.all([tools.run_command({step:1}),tools.run_command({step:2}),tools.run_command({step:3})]);',
  }, { cwd: profile, projectName: 'Release fixture', toolCallLedger: batchLedger });
  assert.equal(batch.isError, true); assert.equal(batch.effectOutcome, undefined);
  assert.equal(cancelledRunningCommand, false); assert.equal(batchLedger.outcomeUnknownTool, undefined);
  report.checks.push('known diagnostic failure does not manufacture an unknown effect from siblings');
  const registry = new ToolRegistry(); let effects = 0;
  registry.register({ name: 'fixture_write', description: 'Fixture', source: 'native',
    parameters: { type: 'object', properties: {} }, mutates: true, parallelSafe: false,
    riskLevel: 'write', handler: async () => { effects++; return unknownToolOutcome('Fixture lost ACK'); } });
  const context = { cwd: profile, projectName: 'Release fixture', toolCallLedger: new ToolCallLedger() };
  const result = await buildCodeExecTool(registry).handler({ code: 'try { await tools.fixture_write({}); } catch {} return "caught";' }, context);
  assert.equal(result.effectOutcome, 'unknown'); assert.equal(result.isError, true);
  assert.equal(result.error.retryable, false);
  assert.equal((await registry.invoke('fixture_write', {}, context)).effectOutcome, 'unknown');
  assert.equal(effects, 1);
  report.checks.push('packaged code_exec preserves uncertainty and prevents duplicate mutation');
  report.passed = true;
}

main().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(() => {
  finished = true;
  writeFileSync(join(output, 'ultra-v3-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});

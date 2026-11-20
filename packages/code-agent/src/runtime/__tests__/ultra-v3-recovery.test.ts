import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import type { ChatProvider, AgentMessage } from '@mcp/provider-sdk';
import type { AgentWorkResult, ScheduledOccurrence } from '@mcp/agent-runtime-contracts';
import { budgetedProvider } from '../ultra-provider.js';
import { requiredWorkResult, withEvidenceReference } from '../work-result.js';
import { ChatScheduler } from '../chat-scheduler.js';
import { reconcileUltraBudget } from '../ultra-budget-recovery.js';
import { migrateChatCheckpoint } from '../chat-checkpoint-migration.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { ChatCheckpoint } from '../chat-checkpoint.js';
import { runReadyWorkflow } from '../../tools/workflow/workflow-readiness.js';
import { workflowTemplate } from '../../tools/workflow/workflow-templates.js';
import { validateWorkflowSteps } from '../../tools/workflow/workflow-types.js';
import type { WorkflowRecord, WorkflowStepState } from '../../tools/workflow/workflow-types.js';

let directory: string, store: ChatCollaborationStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'ultra-recovery-')); store = new ChatCollaborationStore(directory); await store.init(); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

it('rejects malformed or fabricated acceptance; permits one local JSON wrapper repair', () => {
  expect(withEvidenceReference({ content: 'passed' }, 'opaque-123').content).toContain('"evidenceReference":"tool:opaque-123"');
  const result: AgentWorkResult = { schemaVersion: 1, status: 'completed', summary: 'Verified', artifacts: [],
    acceptance: 'accepted', effectOutcome: 'confirmed', evidence: [{ kind: 'test', reference: 'tool:t', outcome: 'passed' }],
    criteria: [{ text: 'Regression passes', status: 'met', evidence: ['tool:t'] }] };
  const transcript: AgentMessage[] = [{ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't', content: 'passed' }] }];
  expect(requiredWorkResult('done!', [], ['Regression passes']).acceptance).toBe('rejected');
  expect(requiredWorkResult(JSON.stringify(result), [], ['Regression passes']).acceptance).toBe('unverified');
  expect(requiredWorkResult('```json\n' + JSON.stringify(result) + '\n```', transcript, ['Regression passes']).acceptance).toBe('accepted');
  transcript[0].content = [{ type: 'tool_result', tool_use_id: 't', content: 'failed', is_error: true }];
  expect(requiredWorkResult(JSON.stringify(result), transcript, ['Regression passes']).status).toBe('partial');
});

it('counts physical retry usage once, even when a wrapped provider is inherited', async () => {
  const ledger = new CollaborationBudget(store.files, 'root', { maxParallel: 2, maxStarts: 4 });
  let calls = 0;
  const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
    calls++;
    await request.onAttempt?.({ status: 503, ok: false, inputTokens: 10, outputTokens: 0, costUsd: .01, durationMs: 1 });
    await request.onAttempt?.({ status: 200, ok: true, inputTokens: 20, outputTokens: 5, costUsd: .02, durationMs: 2 });
    yield { type: 'done', stop_reason: 'end_turn' };
  } };
  const wrapped = budgetedProvider(provider, ledger);
  expect(budgetedProvider(wrapped, ledger)).toBe(wrapped);
  for await (const _ of wrapped.chat({ system: '', messages: [], tools: [] })) { /* consume */ }
  const rows = Object.values((await ledger.state()).reservations);
  expect(calls).toBe(1); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tokens: 35, cost: .03, state: 'settled' });
  await ledger.configure({ maxCostUsd: .04 });
  await expect(async () => { for await (const _ of wrapped.chat({ system: '', messages: [], tools: [] })) { /* consume */ } }).rejects.toThrow('budget_bound_unavailable');
  expect(calls).toBe(1);
});

it('keeps unknown reservations across restart and releases only a matching terminal receipt', async () => {
  const ledger = new CollaborationBudget(store.files, 'root', { maxParallel: 1, maxStarts: 4 });
  await ledger.reserve('agent', 'session'); await ledger.bind('agent', 'session', 'run'); await ledger.settle('agent', 0, null, true);
  await expect(new CollaborationBudget(store.files, 'root', ledger.limits).reserve('second', 's')).rejects.toThrow('effect_unknown');
  await reconcileUltraBudget(ledger, { listSubagentRuns: async () => ({ items: [] }) } as unknown as FsSessionStore);
  expect((await ledger.state()).reservations.agent.state).toBe('unknown');
  await store.files.insert('checkpoints', 'budget-receipt:root:agent', { runId: 'run', confirmed: true });
  await reconcileUltraBudget(ledger, {} as FsSessionStore);
  expect((await ledger.state()).reservations.agent.state).toBe('settled');
  await ledger.configure({ maxParallel: 2 });
  expect(Object.keys((await ledger.state()).reservations)).toHaveLength(1);
});

it('preserves corrupt mailbox bytes and exposes the error instead of an empty inbox', async () => {
  const file = store.files.path('messages', 'corrupt'); await writeFile(file, '{broken');
  await expect(store.pending()).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('{broken');
});

it('keeps an admitted but unconfirmed scheduled run uncertain until its original receipt arrives', async () => {
  let now = Date.now(); await store.registerRoot('a', 'A');
  const scheduler = new ChatScheduler(store, () => now);
  await scheduler.create('a', { kind: 'once', at: now + 1000, timezone: 'UTC', action: 'run', prompt: 'Check', maxRuns: 1, misfire: 'fire_once', overlap: 'coalesce' }, 'one', true);
  now += 1000; await scheduler.tick();
  const row = (await scheduler.records.list<ScheduledOccurrence>('occurrences'))[0];
  await scheduler.reconcile(row.messageId!, 'unknown');
  await new ChatScheduler(store, () => now + 600000).tick();
  expect(await scheduler.records.list('occurrences')).toHaveLength(1);
  expect((await scheduler.records.get<ScheduledOccurrence>('occurrences', row.id))?.state).toBe('outcome_unknown');
  await scheduler.reconcile(row.messageId!, 'succeeded');
  expect((await scheduler.records.get<ScheduledOccurrence>('occurrences', row.id))?.state).toBe('finished');
});

it('backs up a legacy checkpoint only when original terminal configuration is provable', async () => {
  const checkpoint: ChatCheckpoint = { actor: 'chat:a/child:c', spawnId: 's', profile: 'explore', label: 'C', cwd: '/workspace', transcript: [], phase: 'complete' };
  expect(await migrateChatCheckpoint(checkpoint, 'a', store)).toBe(checkpoint);
  const sessions = { listSubagentRuns: async () => ({ items: [{ spawn_id: 's', profile: 'explore', status: 'completed',
    reason: 'completed', effective_provider: 'original', effective_model: 'original-model', effective_reasoning_effort: 'high',
    max_turns: 12, worker_instance_id: 'original-owner', run_id: 'r', seq: 1 }] }) } as unknown as FsSessionStore;
  const migrated = await migrateChatCheckpoint(checkpoint, 'a', store, sessions);
  expect(migrated.execution).toMatchObject({ provider: 'original', model: 'original-model', effort: 'high', maxTurns: 12 });
  expect(await store.files.list('checkpoints')).toHaveLength(2);
});

it('serializes overlapping writers while allowing explicit partial consumption', async () => {
  const steps = [{ id: 'a', files: ['src'], dependsOn: [] }, { id: 'b', files: ['src/file.ts'], dependsOn: [] },
    { id: 'c', files: ['other'], dependsOn: ['a'], acceptPartial: ['a'] }].map(step => ({ ...step, profileId: 'implement', status: 'pending', prompt: step.id, title: step.id, wave: 1 }) as WorkflowStepState);
  let writers = 0, max = 0; const seen: string[] = [];
  await runReadyWorkflow({ steps } as WorkflowRecord, 2, async step => {
    if (step.id !== 'c') { writers++; max = Math.max(max, writers); }
    await Promise.resolve(); seen.push(step.id); step.status = step.id === 'a' ? 'partial' : 'completed';
    if (step.id !== 'c') writers--;
  });
  expect(max).toBe(1); expect(seen).toContain('c');
});

it('does not verify the base checkout before isolated edits have an integration receipt', async () => {
  const steps = [{ id: 'write', dependsOn: [], profileId: 'implement' }, { id: 'verify', dependsOn: ['write'], profileId: 'verify' }]
    .map(step => ({ ...step, status: 'pending', title: step.id, prompt: step.id, wave: 1 }) as WorkflowStepState);
  const record = { steps } as WorkflowRecord;
  const seen: string[] = [];
  const run = async (step: WorkflowStepState) => { seen.push(step.id); step.status = 'completed';
    if (step.id === 'write') step.integration = { chatId: 'child', state: 'pending' }; };
  await runReadyWorkflow(record, 2, run);
  expect(seen).toEqual(['write']); expect(steps[1].status).toBe('pending');
  steps[0].integration!.state = 'integrated';
  await runReadyWorkflow(record, 2, run);
  expect(seen).toEqual(['write', 'verify']);
});

it('templates require explicit ownership and keep verification dependent on implementation', () => {
  expect(() => workflowTemplate('migration', 'Migrate local schema')).toThrow('file ownership');
  for (const name of ['investigate_implement_verify', 'cross_check', 'migration']) {
    const steps = workflowTemplate(name, 'Fix the scoped defect', ['src/component.ts']);
    expect(validateWorkflowSteps(steps)).toEqual([]);
    if (name !== 'cross_check') expect(steps.at(-1)?.depends_on).toEqual(['implement']);
  }
});

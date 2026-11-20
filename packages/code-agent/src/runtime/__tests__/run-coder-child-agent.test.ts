/**
 * Integration: the real runCoder over a temporary database and session data,
 * with a scripted provider. A child-agent session runs with its profile tools
 * and prompt section, is cut at its profile cap with a salvage summary as its
 * final answer, and records its run in its own bundle (a writable depth-1 child
 * may still create_chat); an ordinary session keeps create_chat, no child section.
 *
 * Opens SQLite: runs under the Electron runtime (scripts/test-harness-tools.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDelta } from '../../core/messages.js';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';

const tmp = mkdtempSync(join(tmpdir(), 'run-coder-child-'));
const projectRoot = join(tmp, 'project');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(tmp, 'data', 'sessions', 'global'), { recursive: true });
process.env.MCP_INDEX_DB = join(tmp, 'index.db');
process.env.MCP_DATA_DIR = join(tmp, 'data');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(tmp, 'coordination');

const SALVAGE = 'Salvaged: listed the project three times.';
const seen: Array<{ label: string; system: string; tools: string[] }> = [];
let label = '';

/** model 'loop' lists the project forever; 'answer' answers at once; 'edit-hang' writes a file, then waits to be stopped. */
function scripted(model: string): ChatProvider {
  let call = 0;
  return { name: 'fixture', model, setModel() {}, async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    if (request.system?.includes('forcibly stopped')) {
      yield { type: 'text_delta', text: SALVAGE };
      yield { type: 'done', stop_reason: 'end_turn' };
      return;
    }
    if (call++ === 0) seen.push({ label, system: request.system ?? '', tools: (request.tools ?? []).map((tool) => tool.name) });
    if (model === 'edit-hang') {
      if (call === 1) {
        yield { type: 'usage', usage: HALF_USAGE };
        yield { type: 'tool_call_start', id: 'w1', name: 'write_file' };
        yield { type: 'tool_call_end', id: 'w1', name: 'write_file', input: { path: 'half-done.ts', content: 'export const half = true;\n' } };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 30_000);
      });
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (model === 'loop') {
      yield { type: 'tool_call_start', id: `g${call}`, name: 'glob' };
      yield { type: 'tool_call_end', id: `g${call}`, name: 'glob', input: { pattern: `*.ts` } };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', text: 'Done.' };
    // Only the queued child's run reports usage: the parent's totals must gain exactly this.
    if (label === 'queued') yield { type: 'usage', usage: QUEUED_USAGE };
    yield { type: 'done', stop_reason: 'end_turn' };
  } };
}
const QUEUED_USAGE = { input_tokens: 11, output_tokens: 5 };
const HALF_USAGE = { input_tokens: 7, output_tokens: 3 };

vi.mock('@mcp/services/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCoderProvider: vi.fn(async (_provider: string, model: string) => scripted(model)),
}));

type Ids = { root: string; explore: string; implement: string; verify: string; queued: string; aborted: string };
let ids: Ids;
let projectId: number;

beforeAll(async () => {
  const { CodeIndexDB } = await import('@mcp/store/db.js');
  const { ProviderStore } = await import('@mcp/store/provider-store.js');
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  const { createChildAgentSession } = await import('../child-agent-sessions.js');
  const db = new CodeIndexDB(process.env.MCP_INDEX_DB!);
  projectId = db.createProject('fixture', projectRoot).id;
  db.close();
  const providers = new ProviderStore(process.env.MCP_INDEX_DB!);
  // An available kind (LOCAL_PROVIDER_KINDS): any other is stored but never
  // returned, and its Admin settings would be dropped without a word.
  providers.upsertProvider({ id: 'fixture', name: 'Fixture', kind: 'openai', enabled: true, use_for_coder: true });
  // The admin per-profile cap the child run must honour (keyed by the creator's provider).
  providers.setSubagentProfileLimits('fixture', 'explore', { maxToolCalls: 3 });
  expect(providers.getSubagentProfileLimits('fixture', 'explore')).toEqual({ maxToolCalls: 3, timeoutMs: null });
  providers.close();

  const sessions = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
    resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined),
    listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }],
  } });
  const project = (id: number) => (id === projectId ? { id, name: 'fixture', root_path: projectRoot } : null);
  const root = await sessions.createSession({ project_id: projectId, title: 'Root', provider: 'fixture', model: 'answer', agent: 'build' });
  const make = async (profile: string, model: string, key = profile) => (await createChildAgentSession({ sessions, project }, root.id,
    { key, title: `${key} child`, profile, model })).child.id;
  ids = { root: root.id, explore: await make('explore', 'loop'), implement: await make('implement', 'answer'), verify: await make('verify', 'answer'),
    queued: await make('review', 'answer'), aborted: await make('implement', 'edit-hang', 'aborted') };
  await sessions.close();
}, 60_000);

afterAll(async () => {
  // runCoder keeps one shared central database and session store per process:
  // close them, or Windows refuses to delete the files they hold open.
  const { closeSharedCentral } = await import('../../index.js');
  await closeSharedCentral();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 60_000);

async function run(sessionId: string, as: string) {
  const { runCoder } = await import('../../index.js');
  label = as;
  const handle = await runCoder({ session: { id: sessionId as never }, userMessage: 'Do the task.' });
  return handle.done;
}
const first = (as: string) => seen.find((entry) => entry.label === as)!;
/** A store instance of its own over the same files, as another process (the app) reads them. */
async function openStore() {
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  return FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
    resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined),
    listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
}
const NEVER_IN_A_CHILD = ['spawn_agent', 'collect_agents', 'resume_agent', 'request_review', 'task_complete', 'ask_user'];

describe('runCoder with a child-agent session', () => {
  it('runs an explore child with its tools and prompt, cuts it at the cap and salvages', async () => {
    const done = await run(ids.explore, 'explore');
    const sent = first('explore');
    expect(sent.system).toContain('# Child agent (explore, depth 1)');
    expect(sent.tools).toContain('glob');
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'exec_command', ...NEVER_IN_A_CHILD]) expect(sent.tools).not.toContain(name);
    expect(done.reason).toBe('aborted');

    const reader = await openStore();
    const page = await reader.loadMessagesBefore(ids.explore, Number.MAX_SAFE_INTEGER, 5, true);
    const last = page?.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(JSON.stringify(last?.content)).toContain(SALVAGE);
    const runs = await reader.listSubagentRuns(ids.explore, 0, 5);
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ reason: 'watchdog', tool_calls: 3, profile: 'explore' });
    expect((await reader.listSubagentRuns(ids.root, 0, 5)).items).toEqual([]);
    await reader.close();
  }, 120_000);

  it.each([
    ['implement', ['edit_file'], []],
    ['verify', [], ['write_file', 'edit_file', 'apply_patch']],
  ] as const)('runs a %s child with its profile surface', async (profile, present, absent) => {
    const done = await run(ids[profile], profile);
    const sent = first(profile);
    expect(done.reason).toBe('completed');
    expect(sent.system).toContain(`# Child agent (${profile}, depth 1)`);
    for (const name of present) expect(sent.tools).toContain(name);
    for (const name of [...absent, ...NEVER_IN_A_CHILD]) expect(sent.tools).not.toContain(name);
  }, 120_000);

  it('leaves an ordinary session untouched in the same process', async () => {
    const done = await run(ids.root, 'root');
    const sent = first('root');
    expect(done.reason).toBe('completed');
    expect(sent.system).not.toContain('# Child agent');
    expect(sent.tools).toContain('create_chat'); expect(sent.tools).not.toContain('spawn_agent');
  }, 120_000);

  it('creates, admits, runs, concludes and the wait returns it (app and worker apart)', async () => {
    const { ChatCollaborationStore } = await import('@mcp/session-storage/collaboration/store.js');
    const { ChildAgentAdmission } = await import('../child-agent-admission.js');
    const { ChildAgentRunService } = await import('../child-agent-runs.js');
    const { fileChildAgentQueue } = await import('../child-agent-queue-store.js');
    const { waitForChildAgents } = await import('../child-agent-wait.js');
    const { runCoder } = await import('../../index.js');
    // The app: its own store instance and the queue in its files. runCoder is the child's worker.
    const app = await openStore();
    const mailbox = new ChatCollaborationStore(process.env.MCP_DATA_DIR!);
    await mailbox.init();
    const queue = fileChildAgentQueue(mailbox.files);
    const reads = { getChildAgentSession: (id: string) => app.getChildAgentSession(id), listChildAgentSessions: (id: string) => app.listChildAgentSessions(id),
      listSubagentRuns: (id: string, offset: number, limit: number) => app.listSubagentRuns(id, offset, limit), refreshSession: (id: string) => app.refreshSession(id) };
    const live = new Set<string>();
    let service: InstanceType<typeof ChildAgentRunService>;
    service = new ChildAgentRunService({ sessions: reads, admission: new ChildAgentAdmission({ sessions: reads, queue, isRunning: (id) => live.has(id) }),
      launcher: { isRunning: (id) => live.has(id), async start({ childId, task }) {
        live.add(childId);
        label = 'queued';
        const handle = await runCoder({ session: { id: childId as never }, userMessage: task });
        void handle.done.then((outcome) => { live.delete(childId); return service.ended(childId, outcome.reason); });
      } } });

    await service.request(ids.queued, 'Review the change.');
    const result = await waitForChildAgents({ sessions: reads, queue, refresh: (id) => app.refreshSession(id) },
      { chatIds: [ids.queued], timeoutMs: 60_000, pollMs: 100 });
    expect(result.outcome).toBe('ready');
    expect(result.items[0]).toMatchObject({ chatId: ids.queued, status: 'completed', finalText: 'Done.' });
    expect(first('queued').system).toContain('# Child agent (review, depth 1)');
    await new Promise((done) => setTimeout(done, 200));
    expect(await queue.get(ids.queued)).toMatchObject({ state: 'released' });
    await app.close();
  }, 120_000);

  it("counts the concluded child's usage in the parent once, at the parent's next run", async () => {
    const { childRunUsageKey } = await import('../child-agent-usage.js');
    const totals = async () => {
      const store = await openStore();
      try {
        const { tokens } = await store.getMetricsSummary(ids.root);
        const conclusion = (await store.getChildAgentSession(ids.queued))?.conclusion;
        return { input: tokens.input, output: tokens.output, keys: await store.listAccountedSubagentKeys(ids.root), conclusion };
      } finally { await store.close(); }
    };
    const before = await totals(); // the queued child concluded in the previous case; the root has not run since
    expect(before.conclusion?.usage).toMatchObject(QUEUED_USAGE);
    const key = childRunUsageKey(before.conclusion!.run_id);
    expect(before.keys.has(key)).toBe(false);
    expect((await run(ids.root, 'root-again')).reason).toBe('completed');
    const after = await totals();
    expect(after.keys.has(key)).toBe(true);
    expect({ input: after.input - before.input, output: after.output - before.output }).toEqual({ input: 11, output: 5 });
    expect((await run(ids.root, 'root-third')).reason).toBe('completed');
    const third = await totals();
    expect({ input: third.input, output: third.output }).toEqual({ input: after.input, output: after.output });
  }, 120_000);

  it('records what an aborted child did: the file it changed and the usage so far', async () => {
    const { runCoder } = await import('../../index.js');
    label = 'aborted';
    const controller = new AbortController();
    const handle = await runCoder({ session: { id: ids.aborted as never }, userMessage: 'Write half, then wait.', signal: controller.signal,
      toolPermissionMode: 'unrestricted' });
    await vi.waitFor(() => expect(existsSync(join(projectRoot, 'half-done.ts'))).toBe(true), { timeout: 60_000, interval: 50 });
    // What the worker's abort does: the run's controller, then the runner.
    controller.abort();
    handle.runner.abort();
    await handle.done.catch(() => undefined);
    const store = await openStore();
    try {
      const conclusion = (await store.getChildAgentSession(ids.aborted))?.conclusion;
      expect(conclusion).toMatchObject({ state: 'aborted' });
      expect(conclusion!.changed_files.some((file) => file.replace(/\\/g, '/').endsWith('half-done.ts'))).toBe(true);
      expect(conclusion!.usage.input_tokens).toBeGreaterThanOrEqual(HALF_USAGE.input_tokens);
    } finally { await store.close(); }
  }, 120_000);
});

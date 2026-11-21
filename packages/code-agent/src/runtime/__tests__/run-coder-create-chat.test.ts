/**
 * Integration: the real runCoder with child chats (every session outside
 * Company). The parent sees create_chat and send_chat_message,
 * never spawn_agent, and no retired name in its prompt; its model calls
 * create_chat with a wait; the child session runs (the real runCoder again,
 * as the child's worker); its answer comes back in the same parent run, as
 * that tool's result, and its usage lands in the parent's turn metric
 * (subagent_usage with the run keys); then send_chat_message gives the same
 * child a second task, which is its next run. Each received conclusion is
 * recorded as an investigation, as spawn_agent's results were. The prompt has
 * the explicit-only multi-agent section: runCoder never renders a delegation section.
 *
 * The app side is an in-process ChildChatPort over the child-agent runtime
 * (queue, admission, wait) with its own store instance. Opens SQLite: runs
 * under the Electron runtime (scripts/test-harness-tools.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { ChatDelta } from '../../core/messages.js';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';
import { REPLACED_BY_CHILD_CHATS } from '../../tools/child-chat-surface.js';

const tmp = mkdtempSync(join(tmpdir(), 'run-coder-create-chat-'));
const projectRoot = join(tmp, 'project');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(tmp, 'data', 'sessions', 'global'), { recursive: true });
process.env.MCP_INDEX_DB = join(tmp, 'index.db');
process.env.MCP_DATA_DIR = join(tmp, 'data');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(tmp, 'coordination');

const CHILD_USAGE = { input_tokens: 13, output_tokens: 4 };
const CHILD_MODEL = 'gpt-6.2-sol';
const toolResults: string[] = [];
const childRequests: Array<{ model: string; reasoning?: { effort: string } }> = [];
let selection: { provider: string; model: string; offsets: number[]; total: number; next_offset: number | null } | undefined;
const searchCatalog = `
  let offset = 0;
  const offsets = [];
  do {
    const page = await tools.mcp__list_models({ offset, limit: 100 });
    offsets.push(page.offset);
    const match = page.models.find(m => m.provider.includes('chatgpt') && m.name === 'GPT-6.2-Sol');
    if (match) return { provider: match.provider, model: match.id, offsets, total: page.total, next_offset: page.next_offset };
    offset = page.next_offset;
  } while (offset != null);
  return null;
`;
const firstCall: Record<string, { system: string; tools: string[] }> = {};
// runCoder always sets a multi-agent mode (standard: explicit request only), so the prompt
// carries that section, never the subagents one. On failure, list the sections that came.
const EXPLICIT_ONLY = '# Multi-agent mode (explicit request only)';
const headers = (system: string) => `sections: ${system.split('\n').filter((line) => line.startsWith('# ')).join(' | ')}`;
const RETIRED = new RegExp(`\\b(${Object.keys(REPLACED_BY_CHILD_CHATS).join('|')})\\b`, 'g');
const retiredIn = (system: string) => [...new Set(system.match(RETIRED) ?? [])];

const lastToolResult = (request: ChatRequest): string => {
  const last = [...(request.messages ?? [])].reverse().find((message) => message.role === 'tool');
  const block = last?.content.find(item => item.type === 'tool_result');
  return typeof block?.content === 'string' ? block.content : JSON.stringify(block?.content ?? '');
};

/** The parent can only delegate with the provider and ID it actually found through code_exec. */
function scripted(provider: string, model: string): ChatProvider {
  let call = 0;
  return { name: provider, model, setModel() {}, async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    if (call++ === 0) firstCall[model] = { system: request.system ?? '', tools: (request.tools ?? []).map((tool) => tool.name) };
    if (call === 1) {
      yield { type: 'tool_call_start', id: 'lookup', name: 'code_exec' };
      yield { type: 'tool_call_end', id: 'lookup', name: 'code_exec', input: { code: searchCatalog } };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    if (call === 2) {
      const lookup = lastToolResult(request);
      const returned = lookup.split('[return]\n')[1];
      selection = returned ? JSON.parse(returned) : undefined;
      if (!selection?.provider || !selection.model) {
        yield { type: 'text_delta', text: `Lookup failed: ${lookup}` };
        yield { type: 'done', stop_reason: 'end_turn' };
        return;
      }
      yield { type: 'tool_call_start', id: 'c1', name: 'create_chat' };
      yield { type: 'tool_call_end', id: 'c1', name: 'create_chat', input: {
        title: 'Probe', prompt: 'Report.', profile: 'explore', provider: selection.provider, model: selection.model, effort: 'max',
      } };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    if (call === 3) {
      const result = lastToolResult(request);
      toolResults.push(result);
      const chatId = /Chat ([0-9a-f-]{36})/.exec(result)?.[1] ?? 'missing';
      yield { type: 'tool_call_start', id: 's1', name: 'send_chat_message' };
      yield { type: 'tool_call_end', id: 's1', name: 'send_chat_message', input: { to: chatId, message: 'Second task.' } };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    toolResults.push(lastToolResult(request));
    yield { type: 'text_delta', text: 'All done.' };
    yield { type: 'done', stop_reason: 'end_turn' };
  } };
}

const incidentResults: string[] = [];
type ReviewModel = { id: string; provider: string; supported_reasoning_levels: string[] };
let reviewPage: { total: number; next_offset: number | null; models: ReviewModel[] } | undefined;
const reviewResults: string[] = [];

/** Same empty catalog read and same Bedrock attempts as the screenshot, followed by the returned ChatGPT row. */
function reviewParent(model: string): ChatProvider {
  let step = 0;
  return { name: 'fixture', model, setModel() {}, async *chat(request): AsyncIterable<ChatDelta> {
    if (step === 1) reviewPage = JSON.parse(lastToolResult(request).split('[return]\n')[1]);
    if (step >= 2) reviewResults.push(lastToolResult(request));
    const review = { title: 'Reviewer', prompt: 'Report.', profile: 'review', wait: true };
    const wrong = { ...review, provider: 'bedrock', model: 'global.openai.gpt-6.2-sol' };
    const row = reviewPage?.models[0];
    const calls = [
      { name: 'code_exec', input: { code: 'return await tools.mcp__list_models({});' } },
      { name: 'create_chat', input: { ...wrong, effort: 'max' } },
      { name: 'create_chat', input: { ...wrong, effort: 'high' } },
      { name: 'create_chat', input: wrong },
      { name: 'create_chat', input: { ...review, provider: row?.provider, model: row?.id, effort: 'max' } },
    ];
    const call = calls[step++];
    if (!call) {
      yield { type: 'text_delta', text: 'Review received.' };
      yield { type: 'done', stop_reason: 'end_turn' };
      return;
    }
    const id = 'review-' + step;
    yield { type: 'tool_call_start', id, name: call.name };
    yield { type: 'tool_call_end', id, name: call.name, input: call.input };
    yield { type: 'done', stop_reason: 'tool_use' };
  } };
}

const guesses = [
  { provider: 'openai-chatgpt', model: 'gpt-5-codex', effort: 'xhigh' },
  { provider: 'codex', model: 'gpt-5.2-codex', effort: 'xhigh' },
  { provider: 'chatgpt-codex', model: 'gpt-5.2', effort: 'xhigh' }, {},
  { model: 'gpt-5.2-codex', effort: 'xhigh' },
];
/** Replay the original parent's bad calls. Recovery can only use the target returned by the harness. */
function incidentParent(model: string): ChatProvider {
  let step = 0;
  let recovered: Record<string, string> | undefined;
  return { name: 'meridian', model, setModel() {}, async *chat(request): AsyncIterable<ChatDelta> {
    if (step) {
      const result = lastToolResult(request);
      incidentResults.push(result);
      const hint = /\{"provider":"openai-chatgpt","model":"[^"]+","effort":"[^"]+"\}/.exec(result)?.[0];
      if (hint) recovered = JSON.parse(hint);
    }
    const index = step++;
    if (index >= guesses.length + 3 || (index >= guesses.length && !recovered)) {
      yield { type: 'text_delta', text: 'Finished.' };
      yield { type: 'done', stop_reason: 'end_turn' };
      return;
    }
    const id = 'incident-' + index;
    yield { type: 'tool_call_start', name: 'create_chat', id };
    yield { type: 'tool_call_end', name: 'create_chat', id, input: {
      title: index < guesses.length ? 'Ping' : 'Task ' + index, profile: 'implement', prompt: 'Report.', wait: false,
      ...(index < guesses.length ? guesses[index] : recovered),
    } };
    yield { type: 'done', stop_reason: 'tool_use' };
  } };
}

vi.mock('@mcp/services/providers/factory.js', async (importOriginal) => {
  const factory = await importOriginal<typeof import('@mcp/services/providers/factory.js')>();
  return { ...factory, createCoderProvider: (...args: Parameters<typeof factory.createCoderProvider>) =>
    args[0] === 'fixture' && args[1] === 'review-coordinator' ? reviewParent(args[1]) :
    args[0] === 'fixture' ? scripted('fixture', args[1]!) :
      args[0] === 'meridian' ? incidentParent(args[1]!) : factory.createCoderProvider(...args) };
});

let rootId: string;
let incidentId: string;
let reviewId: string;
let projectId: number;
let closeApp: () => Promise<void>;
const chatgpt = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  childRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: `Child run ${childRequests.length}.` })}\n\n`);
  res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: CHILD_USAGE } })}\n\n`);
});

beforeAll(async () => {
  const { CodeIndexDB } = await import('@mcp/store/db.js');
  const { ProviderStore } = await import('@mcp/store/provider-store.js');
  const { __setStoreForTests } = await import('@mcp/services/providers/shared/store.js');
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  const { ChatCollaborationStore } = await import('@mcp/session-storage/collaboration/store.js');
  const { buildInProcessChildChats } = await import('./in-process-child-chats.js');
  const { createIndexToolsPort } = await import('@mcp/indexer/agent-tools/port.js');
  const { setGlobalIndexTools } = await import('../../ports/index-tools-port.js');
  setGlobalIndexTools(createIndexToolsPort());
  chatgpt.listen(0, '127.0.0.1');
  await once(chatgpt, 'listening');
  const addr = chatgpt.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing HTTP test address');
  const db = new CodeIndexDB(process.env.MCP_INDEX_DB!);
  projectId = db.createProject('fixture', projectRoot).id;
  db.close();
  const providers = new ProviderStore(process.env.MCP_INDEX_DB!);
  providers.upsertProvider({ id: 'fixture', name: 'Fixture', kind: 'openai', enabled: true, use_for_coder: true });
  providers.upsertProvider({ id: 'bedrock', name: 'Amazon Bedrock', kind: 'bedrock', enabled: true });
  providers.replaceModelsFromSource('bedrock', 'manual', [
    { model_id: 'global.openai.gpt-6.2-sol', name: 'GPT-6.2-Sol', can_reason: true, supported_reasoning_levels: ['high', 'max'] },
    ...Array.from({ length: 199 }, (_, i) => ({ model_id: `model-${i}`, name: `Other ${i}` })),
  ]);
  providers.upsertProvider({ id: 'openai-chatgpt', name: 'ChatGPT (Codex)', kind: 'chatgpt', enabled: true,
    use_for_coder: true, api_key: 'loopback-fixture', base_url: `http://127.0.0.1:${addr.port}` });
  providers.replaceModelsFromSource('openai-chatgpt', 'manual', ['Astra', 'Sol'].map(name => ({
    model_id: `gpt-6.2-${name.toLowerCase()}`, name: `GPT-6.2-${name}`, enabled: true, can_reason: true,
    default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'xhigh', 'max'],
  })));
  __setStoreForTests(providers);
  const app = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
    resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined),
    listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
  rootId = (await app.createSession({
    project_id: projectId, title: 'Root', provider: 'fixture', model: 'parent', agent: 'build', reasoning_effort_override: 'low',
  })).id;
  incidentId = (await app.createSession({ project_id: projectId, title: 'Incident', provider: 'meridian',
    model: 'claude-opus-4-7-medium', agent: 'build', reasoning_effort_override: 'low' })).id;
  reviewId = (await app.createSession({ project_id: projectId, title: 'Review', provider: 'fixture',
    model: 'review-coordinator', agent: 'build', reasoning_effort_override: 'low' })).id;
  const mailbox = new ChatCollaborationStore(process.env.MCP_DATA_DIR!);
  await mailbox.init();
  const { runCoder } = await import('../../index.js');
  // The app's side; the launcher runs the child's runCoder as its worker would.
  const host = buildInProcessChildChats({ app, mailbox, project: (id) => (id === projectId ? { id, name: 'fixture', root_path: projectRoot } : null),
    run: async (childId, task) => (await runCoder({ session: { id: childId as never }, userMessage: task })).done });
  closeApp = async () => {
    await host.drain();
    await app.close();
    __setStoreForTests(null);
    providers.close();
  };
}, 60_000);

afterAll(async () => {
  const { setGlobalIndexTools } = await import('../../ports/index-tools-port.js');
  setGlobalIndexTools(null);
  chatgpt.closeAllConnections();
  await new Promise<void>(resolve => chatgpt.close(() => resolve()));
  const { setChildChatPort } = await import('../../ports/child-chat-port.js');
  setChildChatPort(null);
  await closeApp?.();
  const { closeSharedCentral } = await import('../../index.js');
  await closeSharedCentral();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 60_000);

/** Every turn metric of the root's bundle (metrics/turns/turn-N.json); a project session lives under the project root. */
function rootTurnMetrics(): Array<{ subagent_runs?: string[]; subagent_usage?: { input_tokens: number } }> {
  const found: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(tmp, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && /turn-\d+\.json$/.test(entry.name) && path.includes(rootId) && path.includes('metrics')) {
      found.push(JSON.parse(readFileSync(path, 'utf8')));
    }
  }
  return found as never;
}

describe('runCoder with child chats (the default)', () => {
  it('finds Sol on page three, delegates to ChatGPT at max, receives the answer and continues the same child', async () => {
    const { runCoder } = await import('../../index.js');
    const handle = await runCoder({ session: { id: rootId as never }, userMessage: 'Find Sol 6.2 in the ChatGPT catalog and delegate at max effort.' });
    const outcome = await handle.done;
    expect(outcome.reason).toBe('completed');
    expect(firstCall.parent!.tools).toEqual(expect.arrayContaining(['code_exec', 'create_chat', 'send_chat_message']));
    expect(selection, JSON.stringify(outcome)).toEqual({ provider: 'openai-chatgpt', model: CHILD_MODEL, offsets: [0, 100, 200], total: 202, next_offset: null });
    expect(firstCall.parent!.tools).not.toContain('spawn_agent');
    expect(firstCall.parent!.system.includes(EXPLICIT_ONLY), headers(firstCall.parent!.system)).toBe(true);
    expect(retiredIn(firstCall.parent!.system), headers(firstCall.parent!.system)).toEqual([]);
    expect(toolResults[0]).toMatch(/Chat [0-9a-f-]{36}: completed/);
    expect(toolResults[0]).toContain('Child run 1.');
    expect(toolResults[1]).toContain('Child run 2.');
    expect(childRequests).toHaveLength(2);
    for (const request of childRequests) expect(request).toMatchObject({ model: CHILD_MODEL, reasoning: { effort: 'max' } });
    const keyed = rootTurnMetrics().filter((metric) => metric.subagent_runs?.length);
    expect(keyed).toHaveLength(2);
    for (const metric of keyed) {
      expect(metric.subagent_runs).toHaveLength(1);
      expect(metric.subagent_usage?.input_tokens).toBe(CHILD_USAGE.input_tokens);
    }
    const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
    const reader = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
      resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined), listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
    try {
      const children = await reader.listChildAgentSessions(rootId);
      expect(children).toHaveLength(1);
      const [child] = children;
      expect(await reader.getSession(child!.id)).toMatchObject({
        provider: 'openai-chatgpt', model: CHILD_MODEL, reasoning_effort_override: 'max',
      });
      expect(await reader.getSession(rootId)).toMatchObject({ provider: 'fixture', model: 'parent', reasoning_effort_override: 'low' });
      const recorded = (await reader.listInvestigations(rootId, 10)).filter((row) => row.topic === 'Probe').map((row) => row.summary).sort();
      expect(recorded).toEqual(['Child run 1.', 'Child run 2.']);
    } finally { await reader.close(); }
  }, 180_000);

  it('blocks the guessed targets and anonymous ping, then runs exactly three background children on ChatGPT at xhigh', async () => {
    const { runCoder } = await import('../../index.js');
    const { childChatPort } = await import('../../ports/child-chat-port.js');
    const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
    const initial = childRequests.length;
    const handle = await runCoder({ session: { id: incidentId as never }, maxTurns: 12, maxAutoContinues: 0,
      userMessage: 'Agora vc vai coordenar uns 2 3 agentes (um chat para cada) com provider chatgpt codex, modelo sol 6.2 no xhigth' });
    const outcome = await handle.done;
    expect(outcome.reason, outcome.error).toBe('completed');
    expect(incidentResults).toHaveLength(guesses.length + 3);
    for (const error of incidentResults.slice(0, guesses.length)) {
      expect(error).toContain('No child started');
      expect(error).toContain('"model":"gpt-6.2-sol","effort":"xhigh"');
    }
    for (const receipt of incidentResults.slice(guesses.length)) {
      expect(receipt).toContain('started in the background');
      expect(receipt).toContain('openai-chatgpt / gpt-6.2-sol (effort=xhigh)');
    }
    const reader = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
      resolveProjectRoot: id => id === projectId ? projectRoot : undefined, listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
    try {
      const ids = (await reader.listChildAgentSessions(incidentId)).map(child => child.id);
      expect(ids).toHaveLength(3);
      const result = await childChatPort()!.wait(incidentId, { chatIds: ids, mode: 'all', timeoutMs: 45_000 });
      expect(result.items.map(item => item.status)).toEqual(['completed', 'completed', 'completed']);
      for (const id of ids) expect(await reader.getSession(id)).toMatchObject({
        provider: 'openai-chatgpt', model: CHILD_MODEL, reasoning_effort_override: 'xhigh',
      });
      expect(await reader.getSession(incidentId)).toMatchObject({ provider: 'meridian', model: 'claude-opus-4-7-medium', reasoning_effort_override: 'low' });
      expect(childRequests.slice(initial)).toHaveLength(3);
      for (const request of childRequests.slice(initial)) expect(request).toMatchObject({ model: CHILD_MODEL, reasoning: { effort: 'xhigh' } });
    } finally { await reader.close(); }
  }, 120_000);

  it('scopes the original empty lookup and refuses Bedrock even when its catalog also supports max', async () => {
    const { runCoder } = await import('../../index.js');
    const initial = childRequests.length;
    const outcome = await (await runCoder({ session: { id: reviewId as never }, maxTurns: 9, maxAutoContinues: 0,
      userMessage: 'Inicie um agente revisor com chatgpt modelo sol 6.2 no max, e peça para ele ver onde paramos, se não achar o modelo pare e me avise!' })).done;
    expect(outcome.reason, outcome.error).toBe('completed');
    expect(reviewPage).toMatchObject({ total: 1, next_offset: null, models: [{ provider: 'openai-chatgpt', id: CHILD_MODEL,
      supported_reasoning_levels: ['low', 'xhigh', 'max'] }] });
    expect(reviewResults).toHaveLength(4);
    for (const error of reviewResults.slice(0, 3)) expect(error).toMatch(/Provider "bedrock" conflicts.*"openai-chatgpt".*No child started/);
    expect(reviewResults[3]).toContain('openai-chatgpt / gpt-6.2-sol (effort=max)');
    expect(childRequests.slice(initial)).toHaveLength(1);
    expect(childRequests[initial]).toMatchObject({ model: CHILD_MODEL, reasoning: { effort: 'max' } });
  }, 120_000);
});

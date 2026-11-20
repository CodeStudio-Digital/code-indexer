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
const toolResults: string[] = [];
let childRuns = 0;
const firstCall: Record<string, { system: string; tools: string[] }> = {};
// runCoder always sets a multi-agent mode (standard: explicit request only), so the prompt
// carries that section, never the subagents one. On failure, list the sections that came.
const EXPLICIT_ONLY = '# Multi-agent mode (explicit request only)';
const headers = (system: string) => `sections: ${system.split('\n').filter((line) => line.startsWith('# ')).join(' | ')}`;
const RETIRED = new RegExp(`\\b(${Object.keys(REPLACED_BY_CHILD_CHATS).join('|')})\\b`, 'g');
const retiredIn = (system: string) => [...new Set(system.match(RETIRED) ?? [])];

const lastToolResult = (request: ChatRequest): string => {
  const last = [...(request.messages ?? [])].reverse().find((message) => message.role === 'tool');
  return JSON.stringify(last?.content ?? '');
};

/** 'parent' delegates, then continues the same child; 'child' answers with usage. */
function scripted(model: string): ChatProvider {
  let call = 0;
  return { name: 'fixture', model, setModel() {}, async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    if (call++ === 0) firstCall[model] = { system: request.system ?? '', tools: (request.tools ?? []).map((tool) => tool.name) };
    if (model === 'child') {
      childRuns++;
      yield { type: 'text_delta', text: `Child run ${childRuns}.` };
      yield { type: 'usage', usage: CHILD_USAGE };
      yield { type: 'done', stop_reason: 'end_turn' };
      return;
    }
    if (call === 1) {
      yield { type: 'tool_call_start', id: 'c1', name: 'create_chat' };
      yield { type: 'tool_call_end', id: 'c1', name: 'create_chat', input: { title: 'Probe', prompt: 'Report.', profile: 'explore', model: 'child' } };
      yield { type: 'done', stop_reason: 'tool_use' };
      return;
    }
    if (call === 2) {
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

vi.mock('@mcp/services/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCoderProvider: vi.fn(async (_provider: string, model: string) => scripted(model)),
}));

let rootId: string;
let projectId: number;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  const { CodeIndexDB } = await import('@mcp/store/db.js');
  const { ProviderStore } = await import('@mcp/store/provider-store.js');
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  const { ChatCollaborationStore } = await import('@mcp/session-storage/collaboration/store.js');
  const { buildInProcessChildChats } = await import('./in-process-child-chats.js');
  const db = new CodeIndexDB(process.env.MCP_INDEX_DB!);
  projectId = db.createProject('fixture', projectRoot).id;
  db.close();
  const providers = new ProviderStore(process.env.MCP_INDEX_DB!);
  providers.upsertProvider({ id: 'fixture', name: 'Fixture', kind: 'openai', enabled: true, use_for_coder: true });
  providers.close();
  const app = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
    resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined),
    listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
  rootId = (await app.createSession({ project_id: projectId, title: 'Root', provider: 'fixture', model: 'parent', agent: 'build' })).id;
  const mailbox = new ChatCollaborationStore(process.env.MCP_DATA_DIR!);
  await mailbox.init();
  const { runCoder } = await import('../../index.js');
  // The app's side; the launcher runs the child's runCoder as its worker would.
  buildInProcessChildChats({ app, mailbox, project: (id) => (id === projectId ? { id, name: 'fixture', root_path: projectRoot } : null),
    run: async (childId, task) => (await runCoder({ session: { id: childId as never }, userMessage: task })).done });
  closeApp = () => app.close();
}, 60_000);

afterAll(async () => {
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
  it('delegates with create_chat, gets the answer in the same run, records its usage in the turn, and continues the child', async () => {
    const { runCoder } = await import('../../index.js');
    const handle = await runCoder({ session: { id: rootId as never }, userMessage: 'Delegate it.' });
    const outcome = await handle.done;
    expect(outcome.reason).toBe('completed');
    expect(firstCall.parent!.tools).toEqual(expect.arrayContaining(['create_chat', 'send_chat_message']));
    expect(firstCall.parent!.tools).not.toContain('spawn_agent');
    expect(firstCall.parent!.system.includes(EXPLICIT_ONLY), headers(firstCall.parent!.system)).toBe(true);
    expect(retiredIn(firstCall.parent!.system), headers(firstCall.parent!.system)).toEqual([]);
    expect(toolResults[0]).toMatch(/Chat [0-9a-f-]{36}: completed/);
    expect(toolResults[0]).toContain('Child run 1.');
    expect(toolResults[1]).toContain('Child run 2.');
    expect(childRuns).toBe(2);
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
      const recorded = (await reader.listInvestigations(rootId, 10)).filter((row) => row.topic === 'Probe').map((row) => row.summary).sort();
      expect(recorded).toEqual(['Child run 1.', 'Child run 2.']);
    } finally { await reader.close(); }
  }, 180_000);
});

/**
 * Integration: the real runCoder and its real registry, per scenario, with the
 * switch at 0 and on the default path (child chats on). The direct catalog
 * sent to the provider with child chats is the switch-off one without the old
 * delegation and chat tools, plus create_chat and send_chat_message where
 * they apply: no other tool enters or leaves (the optional groups are
 * budgeted on the switch-off surface). Explore, a read-only root with no
 * Agêntico network, gets neither: create_chat is not registered and
 * send_chat_message is deferred. Company never sees the switch (by
 * construction: runCoder turns child chats off there).
 *
 * Opens SQLite: runs under the Electron runtime (scripts/test-harness-tools.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatDelta } from '../../core/messages.js';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';
import { chatToolsForRun } from '../../tools/chat-tool-set.js';
import { REPLACED_BY_CHILD_CHATS } from '../../tools/child-chat-surface.js';

const tmp = mkdtempSync(join(tmpdir(), 'run-coder-catalog-swap-'));
const projectRoot = join(tmp, 'project');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(tmp, 'data', 'sessions', 'global'), { recursive: true });
process.env.MCP_INDEX_DB = join(tmp, 'index.db');
process.env.MCP_DATA_DIR = join(tmp, 'data');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(tmp, 'coordination');
delete process.env.CODER_CHILD_SESSION_AGENTS;

const sent: Record<string, string[]> = {};
function scripted(model: string): ChatProvider {
  return { name: 'fixture', model, setModel() {}, async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
    sent[model] ??= (request.tools ?? []).map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
    yield { type: 'text_delta', text: 'Done.' };
    yield { type: 'done', stop_reason: 'end_turn' };
  } };
}
vi.mock('@mcp/services/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCoderProvider: vi.fn(async (_provider: string, model: string) => scripted(model)),
}));

const offChat = chatToolsForRun({ childChats: false, company: false });
const onChat = chatToolsForRun({ childChats: true, company: false });
/** What the swap may move: every chat or delegation tool that is not the very same tool in both surfaces. */
const FAMILY = new Set([...offChat, ...onChat].map((tool) => tool.name).concat(Object.keys(REPLACED_BY_CHILD_CHATS), ['spawn_agent', 'resume_agent', 'collect_agents'])
  .filter((name) => !onChat.some((tool) => tool.name === name && offChat.includes(tool))));
const PAIR = ['create_chat', 'send_chat_message'];

type Scenario = { label: string; agent: string; pair: string[]; options?: Record<string, unknown>; agentic?: boolean };
const SCENARIOS: Scenario[] = [
  { label: 'build', agent: 'build', pair: PAIR },
  { label: 'preview', agent: 'build', pair: PAIR, options: { previewAvailable: true } },
  { label: 'plan', agent: 'plan', pair: PAIR },
  { label: 'ultra', agent: 'build', pair: PAIR, options: { executionMode: 'ultra' } },
  { label: 'agentic', agent: 'build', pair: PAIR, agentic: true },
  { label: 'explore', agent: 'explore', pair: [] },
];
const ids: Record<string, string> = {};
let projectId: number;

beforeAll(async () => {
  const { CodeIndexDB } = await import('@mcp/store/db.js');
  const { ProviderStore } = await import('@mcp/store/provider-store.js');
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  const { ChatCollaborationStore } = await import('@mcp/session-storage/collaboration/store.js');
  const db = new CodeIndexDB(process.env.MCP_INDEX_DB!);
  projectId = db.createProject('fixture', projectRoot).id;
  db.close();
  const providers = new ProviderStore(process.env.MCP_INDEX_DB!);
  providers.upsertProvider({ id: 'fixture', name: 'Fixture', kind: 'openai', enabled: true, use_for_coder: true });
  providers.close();
  const app = FsSessionStore.fromRoots({ dataDir: process.env.MCP_DATA_DIR!, projectRootResolver: {
    resolveProjectRoot: (id) => (id === projectId ? projectRoot : undefined),
    listProjectRoots: () => [{ project_id: projectId, root_path: projectRoot }] } });
  const mailbox = new ChatCollaborationStore(process.env.MCP_DATA_DIR!);
  await mailbox.init();
  for (const scenario of SCENARIOS) {
    for (const mode of ['off', 'on'] as const) {
      const model = `${scenario.label}-${mode}`;
      const id = (await app.createSession({ project_id: projectId, title: model, provider: 'fixture', model, agent: scenario.agent })).id;
      ids[model] = id;
      // Agêntico: this chat is the enabled root of its own network.
      if (scenario.agentic) await mailbox.files.put('networks', id, { sessionId: id, rootId: id, projectId, enabled: true,
        projectIds: [projectId], role: '', maxSessions: 8, maxWakeups: 50, budgetId: 'initial' });
    }
  }
  await app.close();
}, 60_000);

afterAll(async () => {
  const { closeSharedCentral } = await import('../../index.js');
  await closeSharedCentral();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 60_000);

async function run(scenario: Scenario, mode: 'off' | 'on'): Promise<string[]> {
  const { runCoder } = await import('../../index.js');
  const model = `${scenario.label}-${mode}`;
  if (mode === 'off') process.env.CODER_CHILD_SESSION_AGENTS = '0';
  try {
    const handle = await runCoder({ session: { id: ids[model] as never }, userMessage: 'Answer.', ...scenario.options });
    expect((await handle.done).reason).toBe('completed');
  } finally { delete process.env.CODER_CHILD_SESSION_AGENTS; }
  return sent[model] ?? [];
}

describe('runCoder catalog with child chats', () => {
  it.each(SCENARIOS)('$label: only the delegation tools change', async (scenario) => {
    const off = await run(scenario, 'off');
    const on = await run(scenario, 'on');
    expect(off.length).toBeGreaterThan(10);
    expect({ rest: on.filter((name) => !FAMILY.has(name)) }).toEqual({ rest: off.filter((name) => !FAMILY.has(name)) });
    expect({ swapped: on.filter((name) => FAMILY.has(name)) }).toEqual({ swapped: scenario.pair });
    if (scenario.label !== 'explore') expect(off).toContain('spawn_agent');
  }, 120_000);
});

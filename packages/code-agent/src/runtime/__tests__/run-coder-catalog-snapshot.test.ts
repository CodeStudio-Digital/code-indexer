/**
 * Snapshot of what the provider receives from the real runCoder, per scenario:
 * the tool array (name + sha256 of each serialized definition, in order), the
 * system prompt (length, sha256, `# ` section titles) and the registered tools
 * that were not sent (deferred). Roots run with today's default (child chats
 * on); Company master and subordinate run with a stub orchestrator.
 *
 * Normalized before hashing: the temporary directory (raw, forward-slash and
 * JSON-escaped forms), UUIDs, ISO timestamps and today's date.
 *
 * Record: UPDATE_CATALOG_SNAPSHOT=1. Without it a missing snapshot or scenario
 * fails; nothing is written. Each scenario runs once, in its own session, by
 * whichever case needs it first (order-free). Agêntico with preview must send
 * the same tools as preview alone.
 * Opens SQLite: runs under the Electron runtime (scripts/test-harness-tools.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatDelta } from '../../core/messages.js';
import type { ChatProvider, ChatRequest } from '../../providers/adapter.js';
import { INTERNAL_MCP_ACCESS } from '../../tools/internal-mcp-contract.js';
import { setGlobalIndexTools, type IndexToolsPort } from '../../ports/index-tools-port.js';
import { companyContextFor, type CompanyKind } from './catalog-snapshot-company.js';

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'run-coder-catalog-snapshot.json');
const RECORD = process.env.UPDATE_CATALOG_SNAPSHOT === '1';
const tmp = mkdtempSync(join(tmpdir(), 'run-coder-catalog-snapshot-'));
const projectRoot = join(tmp, 'project');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(join(tmp, 'data', 'sessions', 'global'), { recursive: true });
process.env.MCP_INDEX_DB = join(tmp, 'index.db');
process.env.MCP_DATA_DIR = join(tmp, 'data');
process.env.MCP_RUNTIME_COORDINATION_DIR = join(tmp, 'coordination');

const requests: Record<string, ChatRequest> = {};
vi.mock('@mcp/services/providers/factory.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCoderProvider: vi.fn(async (_provider: string, model: string): Promise<ChatProvider> => ({ name: 'fixture', model, setModel() {},
    async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
      requests[model] ??= request;
      yield { type: 'text_delta', text: 'Done.' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } })),
}));

/** The index tools come from a port with the internal contract's names, as the worker's. */
const INDEX_PORT = {
  catalog: () => Object.keys(INTERNAL_MCP_ACCESS).filter((name) => name !== 'index_project' && name !== 'export_docs').map((name) => ({
    name, description: `${name} (index tool)`, inputSchema: { type: 'object', properties: { project_name: { type: 'string' } }, required: ['project_name'] } })),
  invoke: async () => ({ content: [] }),
} as unknown as IndexToolsPort;

type Scenario = { label: string; agent: string; options?: Record<string, unknown>; agentic?: boolean; company?: CompanyKind };
const SCENARIOS: Scenario[] = [
  { label: 'root-build', agent: 'build' },
  { label: 'root-preview', agent: 'build', options: { previewAvailable: true } },
  { label: 'root-plan', agent: 'plan' },
  { label: 'root-ultra', agent: 'build', options: { executionMode: 'ultra' } },
  { label: 'root-agentic-preview', agent: 'build', agentic: true, options: { previewAvailable: true } },
  { label: 'root-explore', agent: 'explore' },
  { label: 'company-master', agent: 'build', company: 'master' },
  { label: 'company-master-ultra', agent: 'build', company: 'master', options: { executionMode: 'ultra' } },
  { label: 'company-subordinate', agent: 'build', company: 'subordinate' },
  { label: 'company-subordinate-ultra', agent: 'build', company: 'subordinate', options: { executionMode: 'ultra' } },
  { label: 'company-subordinate-app-studio', agent: 'build', company: 'app-studio-subordinate' },
];
const ids: Record<string, string> = {};
let projectId: number;
const recorded: Record<string, unknown> = {};

beforeAll(async () => {
  setGlobalIndexTools(INDEX_PORT);
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
    const id = (await app.createSession({ project_id: projectId, title: scenario.label, provider: 'fixture', model: scenario.label, agent: scenario.agent })).id;
    ids[scenario.label] = id;
    if (scenario.agentic) await mailbox.files.put('networks', id, { sessionId: id, rootId: id, projectId, enabled: true,
      projectIds: [projectId], role: '', maxSessions: 8, maxWakeups: 50, budgetId: 'initial' });
  }
  await app.close();
}, 60_000);

afterAll(async () => {
  setGlobalIndexTools(null);
  if (RECORD && Object.keys(recorded).length > 0) {
    const previous = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, unknown> : {};
    const merged = { ...previous, ...recorded };
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, `${JSON.stringify(Object.fromEntries(Object.keys(merged).sort().map((key) => [key, merged[key]])), null, 2)}\n`);
  }
  const { closeSharedCentral } = await import('../../index.js');
  await closeSharedCentral();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 60_000);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const today = new Date();
const DATES = [today.toISOString().slice(0, 10), `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`];
/** Run-specific text out: the temporary directory in each form, UUIDs, ISO timestamps, today's date. */
function normalize(text: string): string {
  let out = text;
  for (const form of [tmp.replace(/\\/g, '\\\\'), tmp, tmp.replace(/\\/g, '/')]) out = out.replace(new RegExp(escapeRegex(form), 'gi'), '<TMP>');
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ISO>');
  for (const date of DATES) out = out.split(date).join('<DATE>');
  return out;
}

type Captured = Awaited<ReturnType<typeof runScenario>>;
const captured = new Map<string, Promise<Captured>>();
/** The scenario's snapshot, running it the first time a case asks. */
function capture(scenario: Scenario): Promise<Captured> {
  if (!captured.has(scenario.label)) captured.set(scenario.label, runScenario(scenario));
  return captured.get(scenario.label)!;
}

async function runScenario(scenario: Scenario) {
  const { runCoder } = await import('../../index.js');
  const companyContext = scenario.company ? companyContextFor(scenario.company, { projectId, projectRoot }) : undefined;
  const handle = await runCoder({ session: { id: ids[scenario.label] as never }, userMessage: 'Answer.', ...scenario.options,
    ...(companyContext ? { companyContext } : {}) } as never);
  await handle.done.catch(() => undefined);
  const request = requests[scenario.label];
  if (!request) throw new Error(`${scenario.label}: the provider received no request`);
  const tools = (request.tools ?? []).map((tool) => ({ name: tool.name, sha256: sha(normalize(JSON.stringify(tool))) }));
  const system = normalize(typeof request.system === 'string' ? request.system : JSON.stringify(request.system ?? ''));
  const registry = (handle.runner as unknown as { opts?: { registry?: { list(): Array<{ name: string }> } } }).opts?.registry;
  const sent = new Set(tools.map((tool) => tool.name));
  return {
    tools,
    system: { length: system.length, sha256: sha(system), sections: system.split('\n').filter((line) => line.startsWith('# ')) },
    deferred: registry ? registry.list().map((tool) => tool.name).filter((name) => !sent.has(name)).sort() : null,
  };
}

describe('runCoder catalog and prompt snapshot', () => {
  it.each(SCENARIOS)('$label', async (scenario) => {
    const actual = await capture(scenario);
    if (RECORD) { recorded[scenario.label] = actual; return; }
    if (!existsSync(SNAPSHOT)) throw new Error(`No snapshot at ${SNAPSHOT}. Record it with UPDATE_CATALOG_SNAPSHOT=1.`);
    const expected = (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, unknown>)[scenario.label];
    if (expected === undefined) throw new Error(`Scenario "${scenario.label}" is not in ${SNAPSHOT}. Record it with UPDATE_CATALOG_SNAPSHOT=1.`);
    expect(actual).toEqual(expected);
  }, 120_000);

  it('sends the same tools in Agêntico with preview as with preview alone', async () => {
    const byLabel = (label: string) => SCENARIOS.find((scenario) => scenario.label === label)!;
    const [agentic, preview] = await Promise.all([capture(byLabel('root-agentic-preview')), capture(byLabel('root-preview'))]);
    expect(agentic.tools).toEqual(preview.tools);
  }, 240_000);
});

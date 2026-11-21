/** Set CODESTUDIO_LIVE_CHATGPT_DB to run this test against the configured ChatGPT provider.
 * The isolated project copies only enabled catalog metadata. The ChatGPT adapter uses the configured login. */
import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const profile = process.env.CODESTUDIO_LIVE_CHATGPT_DB;
const provider = 'openai-chatgpt';
const model = 'gpt-6.2-sol';

it.skipIf(!profile)('discovers Sol on page three and receives a response from a real ChatGPT child at max', async ({ onTestFinished }) => {
  const tmp = mkdtempSync(join(tmpdir(), 'codestudio-model-delegation-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });
  const root = join(tmp, 'project'), data = join(tmp, 'data');
  mkdirSync(root);
  mkdirSync(join(data, 'sessions', 'global'), { recursive: true });
  vi.stubEnv('MCP_DATA_DIR', data);
  vi.stubEnv('MCP_INDEX_DB', join(data, 'index.db'));
  vi.stubEnv('MCP_RUNTIME_COORDINATION_DIR', join(tmp, 'coordination'));
  vi.stubEnv('CODER_FALLBACK_CHAIN', '');
  const { CodeIndexDB } = await import('@mcp/store/db.js');
  const { ProviderStore } = await import('@mcp/store/provider-store.js');
  const { __setStoreForTests } = await import('@mcp/services/providers/shared/store.js');
  const { FsSessionStore } = await import('@mcp/session-storage/fs-store/index.js');
  const { ChatCollaborationStore } = await import('@mcp/session-storage/collaboration/store.js');
  const { createIndexToolsPort } = await import('@mcp/indexer/agent-tools/port.js');
  const { setGlobalIndexTools } = await import('@mcp/code-agent/ports/index-tools-port.js');
  const { setChildChatPort } = await import('@mcp/code-agent/ports/child-chat-port.js');
  const { buildInProcessChildChats } = await import('@mcp/code-agent/runtime/__tests__/in-process-child-chats.js');
  const { runCoder, closeSharedCentral } = await import('@mcp/code-agent/index.js');
  const source = new Database(profile!, { readonly: true, fileMustExist: true });
  const db = new CodeIndexDB(join(data, 'index.db'));
  const id = db.createProject('synthetic', root).id;
  const project = { id, name: 'synthetic', root_path: root };
  const app = FsSessionStore.fromRoots({ dataDir: data, projectRootResolver: {
    resolveProjectRoot: n => n === id ? root : undefined, listProjectRoots: () => [{ project_id: id, root_path: root }],
  } });
  try {
    const local = new ProviderStore(db.raw());
    const configurations = source.prepare('SELECT id, name, kind FROM provider_configs WHERE enabled=1').all() as
      Array<{ id: string; name: string; kind: string }>;
    const list = source.prepare('SELECT model_id, name, mode, can_reason, default_reasoning_level, supported_reasoning_levels FROM provider_models WHERE provider_id=? AND enabled=1');
    for (const cfg of configurations) {
      local.upsertProvider({ ...cfg, enabled: true, use_for_coder: cfg.id === provider });
      const rows = list.all(cfg.id) as Array<{ model_id: string; name: string; mode: string; can_reason: number;
        default_reasoning_level: string | null; supported_reasoning_levels: string | null }>;
      local.replaceModelsFromSource(cfg.id, 'manual', rows.map(r => ({ ...r, can_reason: !!r.can_reason,
        supported_reasoning_levels: r.supported_reasoning_levels ? JSON.parse(r.supported_reasoning_levels) : null })));
    }
    // A read-only smoke must never rotate an expiring login or send it to a custom gateway.
    const ready = source.prepare('SELECT expires_at FROM oauth_tokens WHERE provider_id=?').get(provider) as { expires_at: number } | undefined;
    expect(ready?.expires_at ?? 0, 'A current ChatGPT login is required').toBeGreaterThan(Date.now() + 240_000);
    const endpoint = source.prepare('SELECT base_url FROM provider_configs WHERE enabled=1 AND id=?').get(provider) as { base_url: string | null };
    expect(new URL(endpoint.base_url ?? 'https://chatgpt.com').origin).toBe('https://chatgpt.com');
    __setStoreForTests(new ProviderStore(source));
    const port = createIndexToolsPort();
    const pages: Array<{ offset: number; found: boolean }> = [];
    setGlobalIndexTools({ ...port, async invoke(name, args, ctx) {
      const result = await port.invoke(name, args, ctx);
      if (name === 'list_models') {
        const page = result.structuredContent as { offset: number; models: Array<{ provider: string; id: string }> };
        pages.push({ offset: page.offset, found: page.models.some(m => m.provider === provider && m.id === model) });
      }
      return result;
    } });
    const mailbox = new ChatCollaborationStore(data);
    await mailbox.init();
    const signal = AbortSignal.timeout(165_000);
    buildInProcessChildChats({ app, mailbox, project: n => n === id ? project : null, run: async (childId, task) => {
      const child = await app.getSession(childId);
      expect(child).toMatchObject({ provider, model, reasoning_effort_override: 'max' });
      return (await runCoder({ session: { id: child!.id }, userMessage: task, allowedToolNames: ['task_complete'],
        maxTurns: 2, maxAutoContinues: 0, signal })).done;
    } });
    const parent = await app.createSession({ project_id: id, title: 'Catalog smoke', provider, model, agent: 'build', reasoning_effort_override: 'low' });
    const outcome = await (await runCoder({ session: { id: parent.id }, maxTurns: 5, maxAutoContinues: 0, signal,
      allowedToolNames: ['code_exec', 'mcp__list_models', 'create_chat'],
      userMessage: 'Teste de paginação. Em code_exec percorra o catálogo inteiro sem filtro, em páginas de 100 começando no offset 0. '
        + 'Use tools.mcp__list_models, leia page.models e continue com page.next_offset até achar o Sol 6.2 do ChatGPT. '
        + 'Retorne apenas o provider e o id dessa linha. Chame create_chat uma vez com os valores encontrados, perfil explore, esforço max e wait=true. '
        + 'Peça ao filho que calcule 17 + 25 e responda somente com SOL- seguido do resultado, sem ferramentas. Retransmita a resposta e encerre.',
    })).done;
    expect(outcome.reason, outcome.error).toBe('completed');
    expect(pages).toEqual([{ offset: 0, found: false }, { offset: 100, found: false }, { offset: 200, found: true }]);
    const children = await app.listChildAgentSessions(parent.id);
    expect(children).toHaveLength(1);
    const assistantText = async (sid: string) => (await app.listMessagesAfter(sid, 0)).messages
      .filter(m => m.role === 'assistant').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
    expect(await assistantText(children[0]!.id)).toContain('SOL-42');
    expect(await assistantText(parent.id)).toContain('SOL-42');
    expect((await app.getSession(parent.id))?.reasoning_effort_override).toBe('low');
  } finally {
    setGlobalIndexTools(null);
    setChildChatPort(null);
    await closeSharedCentral();
    __setStoreForTests(null);
    await app.close();
    db.close();
    source.close();
  }
}, 190_000);

/** Set CODESTUDIO_LIVE_CHATGPT_DB to run this test against the configured ChatGPT provider.
 * The isolated project copies only enabled catalog metadata. The ChatGPT adapter uses the configured login. */
import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MessageChannel } from 'node:worker_threads';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ModelCatalogIndex } from '@mcp/indexer/indexer/providers/model-catalog-index.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';
import { SemanticVectorWorkerClient } from '../../sse/SemanticVectorWorkerClient.js';
import { registerWorkerIndexHandlers } from '../../sse/worker-index-handlers.js';
import { createRpcSemanticSearchClient } from '../index-search-rpc.js';
import type { IndexSearchService } from '../../server/index-search-service.js';

const profile = process.env.CODESTUDIO_LIVE_CHATGPT_DB;
const provider = 'openai-chatgpt';
const model = 'gpt-6.2-sol';
const natural = process.env.CODESTUDIO_LIVE_CHILD_ROUTING === 'natural';
const searchFirst = process.env.CODESTUDIO_LIVE_CHILD_ROUTING === 'provider-search';
const byIntent = process.env.CODESTUDIO_LIVE_CHILD_ROUTING === 'intent';
const reviewer = searchFirst || byIntent || process.env.CODESTUDIO_LIVE_CHILD_ROUTING === 'reviewer';
const effort = natural ? 'xhigh' : 'max';

it.skipIf(!profile)(reviewer ? 'finds the requested ChatGPT reviewer among models from different providers and delegates at max' :
  natural ? 'delegates the natural Portuguese instruction to a real ChatGPT child at xhigh' :
  'discovers Sol on page three and receives a response from a real ChatGPT child at max', async ({ onTestFinished }) => {
  const tmp = mkdtempSync(join(tmpdir(), 'codestudio-model-delegation-'));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  });
  const root = join(tmp, 'project'), data = join(tmp, 'data');
  mkdirSync(root);
  const expectedAnswer = reviewer ? 'REV-' + randomUUID().slice(0, 8).toUpperCase() : 'SOL-42';
  if (reviewer) writeFileSync(join(root, 'CHECKPOINT.md'), '# Revisão sintética\n\nÚltima etapa concluída: importação de exemplo. Marcador ' + expectedAnswer + '.\n');
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
  let host: ReturnType<typeof buildInProcessChildChats> | undefined;
  let closeCatalog: (()=>Promise<void>) | undefined;
  try {
    const local = new ProviderStore(db.raw());
    const configurations = source.prepare('SELECT id, name, kind FROM provider_configs WHERE enabled=1').all() as
      Array<{ id: string; name: string; kind: string }>;
    const list = source.prepare('SELECT model_id, name, mode, description, context_window, input_modalities, can_reason, default_reasoning_level, supported_reasoning_levels FROM provider_models WHERE provider_id=? AND enabled=1');
    for (const cfg of configurations) {
      local.upsertProvider({ ...cfg, enabled: true, use_for_coder: cfg.id === provider });
      const rows = list.all(cfg.id) as Array<{ model_id: string; name: string; mode: string; can_reason: number;
        description:string|null; context_window:number|null; input_modalities:string|null; default_reasoning_level: string | null; supported_reasoning_levels: string | null }>;
      local.replaceModelsFromSource(cfg.id, 'manual', rows.map(r => ({ ...r, can_reason: !!r.can_reason,
        input_modalities:r.input_modalities ? JSON.parse(r.input_modalities) : null,
        supported_reasoning_levels: r.supported_reasoning_levels ? JSON.parse(r.supported_reasoning_levels) : null })));
    }
    // A read-only smoke must never rotate an expiring login or send it to a custom gateway.
    const ready = source.prepare('SELECT expires_at FROM oauth_tokens WHERE provider_id=?').get(provider) as { expires_at: number } | undefined;
    expect(ready?.expires_at ?? 0, 'A current ChatGPT login is required').toBeGreaterThan(Date.now() + 240_000);
    const endpoint = source.prepare('SELECT base_url FROM provider_configs WHERE enabled=1 AND id=?').get(provider) as { base_url: string | null };
    expect(new URL(endpoint.base_url ?? 'https://chatgpt.com').origin).toBe('https://chatgpt.com');
    __setStoreForTests(new ProviderStore(source));
    let searchClient;
    if (byIntent) {
      const encoderWorker=SemanticVectorWorkerClient.create(join(data,'index.db'));
      const catalog=new ModelCatalogIndex(db,encoderWorker.embeddingService(BUNDLED_EMBEDDING_TARGET));
      const discovery=new ModelDiscovery(db,(request,signal)=>catalog.search(request,signal));
      const channels=new MessageChannel(), main=new MessageBridge({port:channels.port1}), worker=new MessageBridge({port:channels.port2});
      const off=registerWorkerIndexHandlers(main,()=>({ids:{}}),()=>({catalogSearch:discovery.searchIntent.bind(discovery)} as IndexSearchService));
      searchClient=createRpcSemanticSearchClient(worker);
      closeCatalog=async()=>{off();main.dispose();worker.dispose();channels.port1.close();channels.port2.close();await catalog.close();await encoderWorker.dispose();};
      await catalog.prepare();
    }
    const port = createIndexToolsPort({semanticSearchClient:searchClient});
    const pages: Array<{ offset: number; found: boolean }> = [];
    const lookups: Array<Record<string, unknown>> = [];
    setGlobalIndexTools({ ...port, async invoke(name, args, ctx) {
      const result = await port.invoke(name, args, ctx);
      if (name === 'list_models') {
        const page = result.structuredContent as { total: number; offset: number; search?:{mode:string}; providers?: Array<{ id: string }>;
          models?: Array<{ provider: string; id: string; supported_reasoning_levels?: string[] }> } | undefined;
        if (page) {
          pages.push({ offset: page.offset, found: !!page.models?.some(m => m.provider === provider && m.id === model) });
          lookups.push({ provider: args.provider, query: args.query, view: args.view, mode:page.search?.mode, total: page.total, providerIds: page.providers?.map(p => p.id),
            targetOnPage: pages.at(-1)?.found, providersOnPage: [...new Set(page.models?.map(m => m.provider))],
            targetEfforts: page.models?.find(m => m.provider === provider && m.id === model)?.supported_reasoning_levels });
        }
      }
      return result;
    } });
    const mailbox = new ChatCollaborationStore(data);
    await mailbox.init();
    const signal = AbortSignal.timeout(165_000);
    host = buildInProcessChildChats({ app, mailbox, project: n => n === id ? project : null, run: async (childId, task) => {
      const child = await app.getSession(childId);
      expect(child).toMatchObject({ provider, model, reasoning_effort_override: effort });
      return (await runCoder({ session: { id: child!.id }, userMessage: task,
        ...(reviewer ? {} : { allowedToolNames: ['task_complete'] }), maxTurns: reviewer ? 5 : 2, maxAutoContinues: 0, signal })).done;
    } });
    const parentModel = natural || reviewer ? 'gpt-6.2-astra' : model;
    const parent = await app.createSession({ project_id: id, title: 'Catalog smoke', provider, model: parentModel, agent: 'build', reasoning_effort_override: 'low' });
    const outcome = await (await runCoder({ session: { id: parent.id }, maxTurns: reviewer ? 8 : 5, maxAutoContinues: 0, signal,
      ...(reviewer ? {} : { allowedToolNames: ['code_exec', 'mcp__list_models', 'create_chat'] }),
      userMessage: byIntent ? 'Abra um agente revisor no ChatGPT. Pesquise por intenção no catálogo pela descrição de modelo rápido para programação e tarefas do dia a dia. ' +
        'Preciso da versão atual mais recente que atenda à finalidade e anuncie contexto de pelo menos 500000 tokens e esforço max. ' +
        'Use esse esforço no filho. Peça ao revisor que leia CHECKPOINT.md e retorne o marcador; retransmita a resposta dele.' :
        reviewer ? (searchFirst ? 'Pesquise no catálogo local pelo nome do provedor Codex. Dentro dele pesquise o modelo e confira os esforços disponíveis. ' : '')
        + 'Inicie um agente revisor com chatgpt modelo sol 6.2 no max, e peça para ele ver onde paramos, se não achar o modelo pare e me avise! '
        + 'Peça ao revisor que leia CHECKPOINT.md no projeto e traga o marcador de lá na resposta.' :
        natural ? 'Abra um chat filho com provider chatgpt codex, modelo sol 6.2 no xhigth. '
        + 'Peça a ele que calcule 17 + 25 e responda somente com SOL- seguido do resultado. Traga a resposta dele aqui.' :
        'Teste de paginação. Em code_exec percorra o catálogo inteiro sem filtro, em páginas de 100 começando no offset 0. '
        + 'Use tools.mcp__list_models, leia page.models e continue com page.next_offset até achar o Sol 6.2 do ChatGPT. '
        + 'Retorne apenas o provider e o id dessa linha. Chame create_chat uma vez com os valores encontrados, perfil explore, esforço max e wait=true. '
        + 'Peça ao filho que calcule 17 + 25 e responda somente com SOL- seguido do resultado, sem ferramentas. Retransmita a resposta e encerre.',
    })).done;
    const children = await app.listChildAgentSessions(parent.id);
    if (reviewer) {
      const messages = (await app.listMessagesAfter(parent.id, 0)).messages;
      const calls = messages.flatMap(m => m.content.flatMap(b => {
        if (b.type !== 'tool_use') return [];
        const { provider, model, effort, profile } = b.input as Record<string, unknown>;
        return [{ tool: b.name, provider, model, effort, profile }];
      }));
      const errors = messages.flatMap(m => m.content.flatMap(b => b.type === 'tool_result' && b.is_error && typeof b.content === 'string' ? [b.content.slice(0, 400)] : []));
      const childMessages = children.length === 1 ? (await app.listMessagesAfter(children[0]!.id, 0)).messages : [];
      const checkpointRead = childMessages.some(m => m.content.some(b => b.type === 'tool_result' && JSON.stringify(b.content).includes(expectedAnswer)));
      const trace = { parent: parentModel, outcome: outcome.reason, lookups, calls, errors, checkpointRead,
        children: await Promise.all(children.map(async c => { const s = await app.getSession(c.id);
          return { profile: c.profile, provider: s?.provider, model: s?.model, effort: s?.reasoning_effort_override }; })) };
      if (process.env.CODESTUDIO_LIVE_ROUTING_REPORT) writeFileSync(process.env.CODESTUDIO_LIVE_ROUTING_REPORT, JSON.stringify(trace, null, 2));
      expect(checkpointRead, JSON.stringify(trace)).toBe(true);
      if (byIntent) {
        expect(lookups.some(l=>l.mode==='hybrid' && l.targetOnPage && Array.isArray(l.providersOnPage) &&
          l.providersOnPage.length===1 && l.providersOnPage[0]===provider),JSON.stringify(trace)).toBe(true);
        expect(calls.filter(c=>c.tool==='create_chat')).toHaveLength(1);
      }
      if (searchFirst) expect(lookups.some(l => l.targetOnPage && Array.isArray(l.providersOnPage) &&
        l.providersOnPage.length === 1 && l.providersOnPage[0] === provider && Array.isArray(l.targetEfforts) && l.targetEfforts.includes('max')), JSON.stringify(lookups)).toBe(true);
    }
    expect(outcome.reason, outcome.error).toBe('completed');
    if (!natural && !reviewer) expect(pages).toEqual([{ offset: 0, found: false }, { offset: 100, found: false }, { offset: 200, found: true }]);
    expect(children).toHaveLength(1);
    if (reviewer) expect(children[0]?.profile).toBe('review');
    const assistantText = async (sid: string) => (await app.listMessagesAfter(sid, 0)).messages
      .filter(m => m.role === 'assistant').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
    expect(await assistantText(children[0]!.id)).toContain(expectedAnswer);
    expect(await assistantText(parent.id)).toContain(expectedAnswer);
    expect(await app.getSession(parent.id)).toMatchObject({ provider, model: parentModel, reasoning_effort_override: 'low' });
  } finally {
    await host?.drain();
    await closeCatalog?.();
    setGlobalIndexTools(null);
    setChildChatPort(null);
    await closeSharedCentral();
    __setStoreForTests(null);
    await app.close();
    db.close();
    source.close();
  }
}, 190_000);

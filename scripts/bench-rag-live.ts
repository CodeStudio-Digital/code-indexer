/** Opt-in paid benchmark. Only authored synthetic fixtures enter Bedrock requests. */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletion } from 'openai/resources/chat/completions';
import { get as getProvider } from '@mcp/store/provider/providers.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore } from '@mcp/store/doc-store.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';
import { DocHybridSearch, vectorIdForChunk } from '@mcp/services/services/docs/search.js';
import { buildEmbeddingText } from '@mcp/services/services/docs/index-doc-use-case/utils.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { DocsEvidenceLedger } from '@mcp/docs-agent/tools/evidence-ledger.js';
import { makeDocsSearchTool } from '@mcp/docs-agent/tools/docs-search-chunks.js';
import { makeDocsReadChunkTool } from '@mcp/docs-agent/tools/docs-read-chunk.js';
import { makeDocsFinishTool, type DocsFinishSlot } from '@mcp/docs-agent/tools/docs-finish.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { Topic } from './bench-rag-temporal.js';
import { makeDocsPlanTool, type PlanSlot } from '@mcp/docs-agent/tools/docs-plan.js';
import { buildDocsSystemPrompt } from '@mcp/docs-agent/prompts/system-prompt.js';

const { values } = parseArgs({ options: { 'budget-usd': { type: 'string' }, output: { type: 'string' }, tasks: { type: 'string' }, planned: { type: 'boolean' } } });
const budget = Number(values['budget-usd']);
const total = Number(values.tasks ?? 30);
if (!Number.isFinite(budget) || budget <= 0 || !values.output || !Number.isInteger(total) || total < 1 || total > 40) {
  throw new Error('Supply --budget-usd, --output and 1–40 tasks. This benchmark uses paid Bedrock inference.');
}
const out = resolve(values.output);
mkdirSync(out, { recursive: true });
const lock = join(out, 'run.lock');
const fd = openSync(lock, 'wx');
writeFileSync(fd, String(process.pid)); closeSync(fd);
try {
  await main();
} finally { unlinkSync(lock); }

async function main() {
  const callsFile = join(out, 'calls.jsonl'), resultsFile = join(out, values.planned ? 'tasks-planned.jsonl' : 'tasks.jsonl');
  const readRows = <T>(file: string): T[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s) as T) : [];
  const append = (file: string, value: unknown) => appendFileSync(file, JSON.stringify(value) + '\n');
  const model = 'zai.glm-5';
  const catalog = new Database(join(homedir(), '.mcp-code-indexer', 'index.db'), { readonly: true, fileMustExist: true });
  let key: string, endpoint: URL, region: string;
  try {
    const binding = catalog.prepare('SELECT provider_id,model_id FROM pipeline_provider_bindings WHERE pipeline_name=? AND binding_role=? AND enabled=1')
      .get('docs_research', 'scorer_llm') as { provider_id: string; model_id: string } | undefined;
    if (binding?.model_id !== model || binding.provider_id !== 'aws') throw new Error('The configured benchmark model or provider changed');
    const provider = getProvider(catalog, binding.provider_id);
    if (provider?.kind !== 'openai' || !provider.api_key || !provider.base_url) throw new Error('AWS Mantle provider is unavailable');
    endpoint = new URL(provider.base_url.replace(/\/+$/, '') + '/chat/completions');
    const host = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(endpoint.hostname);
    if (!host || endpoint.protocol !== 'https:' || endpoint.pathname !== '/v1/chat/completions' ||
      endpoint.port || endpoint.search || endpoint.username || endpoint.password) throw new Error('Unexpected AWS Mantle endpoint');
    region = host[1]!;
    key = provider.api_key;
  } finally { catalog.close(); }
  const rates = ['us-east-1', 'us-east-2', 'us-west-2'].includes(region) ? [1, 3.2]
    : region === 'eu-west-2' ? [1.55, 4.96] : region === 'ap-southeast-2' ? [1.03, 3.30]
    : ['ap-southeast-3', 'ap-south-1', 'ap-northeast-1', 'sa-east-1', 'eu-north-1', 'eu-central-1', 'eu-west-1', 'eu-south-1'].includes(region) ? [1.20, 3.84] : null;
  if (!rates) throw new Error('Confirm standard GLM 5 token prices for region ' + region);
  const outputCap = 1536;
  // One million input tokens exceeds the entire GLM 5 context. Reserve before
  // sending. An ambiguous failure or a killed process keeps its full reserve.
  const reserve = rates[0]! + rates[1]! * outputCap / 1e6;
  type Receipt = { id: number; charged: number; input?: number; output?: number };
  const receipts = new Map(readRows<Receipt>(callsFile).map(r => [r.id, r]));
  const spent = () => [...receipts.values()].reduce((sum, row) => sum + row.charged, 0);
  const record = (r: Receipt) => { append(callsFile, r); receipts.set(r.id, r); };
  const invoke = async (messages: ChatCompletionMessageParam[], toolset: ChatCompletionTool[], system: string) => {
    if (spent() + reserve > budget) throw new Error('Budget cannot cover the next request');
    const id = receipts.size + 1;
    record({ id, charged: reserve });
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages],
        tools: toolset, max_completion_tokens: outputCap }), redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      if ([400, 401, 403, 404, 422].includes(response.status)) record({ id, charged: 0, input: 0, output: 0 });
      const message = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new Error('AWS Mantle HTTP ' + response.status + ': ' + String(message.error?.message ?? message.error?.code ?? '').replaceAll(key, '[redacted]').slice(0, 280));
    }
    const body = await response.json() as ChatCompletion;
    const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = body.usage ?? {};
    if (inputTokens === undefined || outputTokens === undefined) throw new Error('Provider omitted usage; reservation retained');
    record({ id, charged: (rates[0]! * inputTokens + rates[1]! * outputTokens) / 1e6, input: inputTokens, output: outputTokens });
    if (!body.choices[0]?.message) throw new Error('AWS Mantle returned no assistant message');
    return body.choices[0].message;
  };
  const topics: Topic[] = JSON.parse(readFileSync('evals/agent-ide-reliability/semantic-fixtures.json', 'utf8')).entries;
  const dir = join(out, 'fixture-' + Date.now());
  mkdirSync(dir);
  process.env.MCP_DATA_DIR = dir;
  const db = new CodeIndexDB(join(dir, 'corpus.db'));
  const docs = new DocStore(db.raw());
  const vectors = new SqliteVecVectorStore({ path: join(dir, 'vectors.db') });
  const embedding = new LocalEmbeddingService();
  const ids = new Map<string, number>();
  try {
    for (const version of ['current', 'previous', 'empty']) {
      const collection = docs.createCollection({ name: version });
      if (version === 'empty') continue;
      const docsToEmbed = topics.map(([name, description]) => {
        const uri = 'fixture://manual/' + version + '/' + name + '.md';
        const source = docs.createSource({ collection_id: collection.id, type: 'url', uri });
        const content = description + '\nModule: ' + version + '/' + name + '.ts\nPolicy: ' +
          (version === 'current' ? 'validate_then_publish' : 'publish_then_validate');
        const [id] = docs.insertChunks([{ source_id: source.id, collection_id: collection.id, ord: 0, content,
          heading_path: name, source_uri: uri, content_hash: createHash('sha256').update(content).digest('hex') }]);
        ids.set(version + '/' + name, id!);
        return { id: id!, text: buildEmbeddingText(name, null, content) };
      });
      for (let i = 0; i < docsToEmbed.length; i += 8) {
        const batch = docsToEmbed.slice(i, i + 8), { vectors: encoded } = await embedding.embed(batch.map(d => d.text));
        await vectors.upsert(batch.map((d, j) => ({ id: vectorIdForChunk(d.id), values: encoded[j]!,
          metadata: { type: 'doc_chunk', chunk_id: String(d.id) } })), docNamespace(collection.id));
      }
    }
    const search = new DocHybridSearch(docs, embedding, vectors);
    const accepted = readRows<{ topic: string; pass: boolean }>(resultsFile);
    const done = new Set(accepted.map(t => t.topic));
    const system = 'Research the supplied synthetic manuals. Use docs_search to locate passages, docs_read_chunk to verify them, then docs_finish. Cite only evidence you actually read. Give the exact module and policy identifiers in backticks. State explicitly what the sources do not establish. Use the language of the question.';
    let cursor = 0, fatal: unknown;
    const worker = async () => {
      while (!fatal && cursor < total) {
        const i = cursor++, [topic] = topics[i]!;
        if (done.has(topic)) continue;
        const versions = ['current', i % 2 === 0 ? 'previous' : 'empty'];
        const byName = new Map(versions.map(v => [v, docs.getCollectionByName(v)!.id]));
        const scopeIds = new Set(byName.values()), ledger = new DocsEvidenceLedger(), slot: DocsFinishSlot = { payload: null };
        const planSlot: PlanSlot = { subQuestions: null };
        const tools = [...(values.planned ? [makeDocsPlanTool({ slot: planSlot })] : []),
          makeDocsSearchTool({ docHybridSearch: search, scopedCollections: versions, scopeIds, collectionIdsByName: byName, ledger,
            subQuestionCount: () => planSlot.subQuestions?.length ?? 1 }),
          makeDocsReadChunkTool({ docStore: docs, scopeIds, ledger }), makeDocsFinishTool({ docStore: docs, scopeIds, slot, ledger, planSlot })];
        const wireTools: ChatCompletionTool[] = tools.map(t => ({ type: 'function', function: {
          name: t.name, description: t.description, parameters: { ...t.parameters } } }));
        const question = i % 3 === 0
          ? 'For ' + topic + ', give the current module path and policy and compare with the previous manual if available. Is there a monthly fee?'
          : 'Qual é o caminho do módulo e a política vigente de ' + topic + '? Compare com o manual anterior se disponível. Existe mensalidade documentada?';
        const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: question + ' Available collections: ' + versions.join(', ') }];
        const trace = [], started = Date.now();
        try {
          for (let turn = 0; turn < 6 && !slot.payload; turn++) {
            const instructions = values.planned ? buildDocsSystemPrompt({ collections: docs.listCollections(), scopedCollections: versions })
              + '\nReturn exact path and policy identifiers. Synthesis is optional. Answer using the language of the question.' : system;
            const answer = await invoke(messages, wireTools, instructions);
            messages.push(answer);
            for (const call of answer.tool_calls ?? []) {
              if (call.type !== 'function') throw new Error('Unexpected non-function tool call');
              const tool = tools.find(t => t.name === call.function.name);
              if (!tool) throw new Error('Unexpected tool request');
              const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
              const result = await tool.handler(args, { cwd: dir, projectName: 'synthetic' } as ToolContext);
              trace.push({ tool: tool.name, args, error: !!result.isError });
              messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
            }
            if (slot.payload) break;
            if (!answer.tool_calls?.length) messages.push({ role: 'user', content: 'Please submit your answer using docs_finish.' });
          }
          const payload = slot.payload, markdown = payload?.markdown ?? '', cited = payload?.chunks_cited ?? [];
          const hasHistory = i % 2 === 0;
          const checks = { currentModule: markdown.includes('current/' + topic + '.ts'), policy: markdown.includes('validate_then_publish'),
            currentCitation: cited.includes(ids.get('current/' + topic)!),
            history: hasHistory ? markdown.includes('publish_then_validate') && cited.includes(ids.get('previous/' + topic)!)
              : !markdown.includes('publish_then_validate') && /(?:indispon|ausent|não|nao|unavailable|cannot|could not|no previous|not available|no evidence)/i.test(markdown),
            price: /(?:mensal|preço|preco|custo|taxa|fee|pric|charg|cost)/i.test(markdown) && !/(?:R\$|US\$|€|\$)\s*\d/i.test(markdown)
                && /(?:não|nenhum|sem evid|sem informa|no |not |unavailable|cannot|unspecified|undocumented)/i.test(markdown) };
          const pass = !!payload && Object.values(checks).every(Boolean);
          append(resultsFile, { topic, hasHistory, question, elapsedMs: Date.now() - started, trace, payload, checks, pass });
          accepted.push({ topic, pass });
          console.log(accepted.length + '/' + total + ' ' + topic + ' pass=' + pass + ' accountedUSD=' + spent().toFixed(4));
        } catch (e) { fatal = e; }
      }
    };
    await Promise.all([worker(), worker()]);
    const report = { model, region, rates, embedding: embedding.diagnostics(), planned: total, completed: accepted.length,
      correct: accepted.filter(t => t.pass).length, billedEstimateUSD: [...receipts.values()].filter(r => r.input !== undefined).reduce((n,r) => n+r.charged, 0),
      unresolvedReservations: [...receipts.values()].filter(r => r.input === undefined).length, accountedUSD: spent(),
      budgetUSD: budget, calls: receipts.size, error: fatal instanceof Error ? fatal.name : undefined };
    writeFileSync(join(out, values.planned ? 'summary-planned.json' : 'summary.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (fatal) throw fatal;
  } finally { await embedding.dispose(); vectors.close(); db.close(); }
}

/** Compare evidence actually visible in the synthesis prompt at one token budget. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutoTokenizer } from '@huggingface/transformers';
import { resolveBundledEmbeddingPath } from '@mcp/indexer/search/bundled-model-path.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { DocStore, type DocChunk } from '@mcp/store/doc-store.js';
import { buildSynthesisPrompt } from '@mcp/docs-agent/prompts/synthesis-prompt.js';

const out = resolve('.tmp/agent-ide-reliability', 'context-' + Date.now());
mkdirSync(out, { recursive: true });
process.env.MCP_DATA_DIR = join(out, 'profile');
const db = new CodeIndexDB(join(out, 'index.db'));
const docs = new DocStore(db.raw());
const tokenizer = await AutoTokenizer.from_pretrained(resolveBundledEmbeddingPath(), { local_files_only: true });
const budget = 540;
const corpus = readFileSync('evals/agent-ide-reliability/semantic-fixtures.json');
const topics = (JSON.parse(corpus.toString()) as { entries: string[][] }).entries;
const modes = ['raw', 'deduplicated', 'one-neighbor', 'same-heading'] as const;
type Mode = typeof modes[number];

function candidates(seeds: DocChunk[], mode: Mode): DocChunk[] {
  if (mode === 'raw') return seeds;
  const seen = new Set<string>();
  const result: DocChunk[] = [];
  for (const seed of seeds) {
    const neighbors = mode === 'one-neighbor' ? docs.getChunkNeighbors(seed.id, 1)
      : mode === 'same-heading' ? docs.listChunksBySourceHeading(seed.source_id, seed.heading_path, seed.source_uri) : [];
    for (const chunk of [seed, ...neighbors]) {
      const key = JSON.stringify([chunk.source_id, chunk.source_uri, chunk.heading_path, chunk.content_hash]);
      if (!seen.has(key)) { seen.add(key); result.push(chunk); }
    }
  }
  return result;
}

function pack(query: string, ranked: DocChunk[]) {
  const selected: DocChunk[] = [];
  const prompt = (chunks: DocChunk[]) => buildSynthesisPrompt({ query, outline: ['Answer'], chunks });
  const tokens = (p: ReturnType<typeof prompt>) => tokenizer.encode(p.system).length + tokenizer.encode(p.user).length;
  for (const chunk of ranked) {
    if (tokens(prompt([...selected, chunk])) <= budget) selected.push(chunk);
  }
  const p = prompt(selected);
  return { user: p.user, tokens: tokens(p), ids: selected.map(c => c.id) };
}

try {
  const collection = docs.createCollection({ name: 'manuals' });
  const rows: Array<{ topic: string; kind: string; mode: Mode; split: string; ids: number[];
    tokens: number; found: number; expected: number; complete: boolean }> = [];
  for (const [index, [topic]] of topics.entries()) {
    if (!topic) throw new Error('Every fixture entry must have a topic');
    const route = 'route_' + index, check = 'check_' + index, owner = 'owner_' + index, policy = 'policy_' + index;
    const intro = topic + ' operations reference. Use ' + route + ' for deployment. '
      + 'Read the change history before making administrative changes. '.repeat(3);
    for (const [manual, passages] of [
      ['operations', [['Deployment', intro], ['Deployment', 'The acceptance code is ' + check + '.'],
        ['Deployment', intro], ['Contacts', 'The responsible operator is ' + owner + '.']]],
      ['policies', [['Policy', topic + ' policy reference. The applicable rule is ' + policy + '.']]],
    ] as const) {
      const uri = 'fixture://manual/' + topic + '/' + manual;
      const source = docs.createSource({ collection_id: collection.id, type: 'url', uri });
      docs.insertChunks(passages.map(([heading, content], ord) => ({
        source_id: source.id, collection_id: collection.id, ord, heading_path: heading, content, source_uri: uri,
        content_hash: createHash('sha256').update(content).digest('hex'),
      })));
    }
    // Freeze exactly the same lexical seed list for every assembly strategy.
    const hits = docs.searchChunksFts(topic, { collectionId: collection.id, limit: 6 });
    const byId = new Map(docs.getChunksByIds(hits.map(h => h.chunk_id)).map(c => [c.id, c]));
    const seeds = hits.map(h => byId.get(h.chunk_id)!);
    if (seeds.length !== 3) throw new Error('Expected three ranked passages for ' + topic);
    for (const [kind, question, wanted] of [
      ['direct', 'Which deployment route applies?', [route]],
      ['continuation', 'Which deployment route and acceptance code apply?', [route, check]],
      ['neighbor', 'Which deployment route and operator apply?', [route, owner]],
      ['two-sources', 'Which deployment route and policy apply?', [route, policy]],
    ] as const) {
      for (const mode of modes) {
        const packed = pack(topic + ' ' + question, candidates(seeds, mode));
        const found = wanted.filter(marker => new RegExp('\\b' + marker + '\\b').test(packed.user)).length;
        rows.push({ topic, kind, mode, split: index % 5 ? 'acceptance' : 'tuning', ids: packed.ids,
          tokens: packed.tokens, found, expected: wanted.length, complete: found === wanted.length });
      }
    }
  }
  const summary = Object.fromEntries(modes.map(mode => {
    const held = rows.filter(r => r.mode === mode && r.split === 'acceptance');
    return [mode, { tasks: held.length, complete: held.filter(r => r.complete).length,
      evidence: held.reduce((sum,r) => sum + r.found, 0), expected: held.reduce((sum,r) => sum + r.expected, 0),
      meanTokens: held.reduce((sum,r) => sum + r.tokens, 0) / held.length,
      byKind: Object.fromEntries([...new Set(held.map(r => r.kind))].map(kind =>
        [kind, held.filter(r => r.kind === kind && r.complete).length])) }];
  }));
  writeFileSync(join(out, 'metrics.json'), JSON.stringify(rows));
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ budget, tokenizer: 'bundled Granite',
    corpusSHA256: createHash('sha256').update(corpus).digest('hex'), summary }, null, 2));
  console.log(JSON.stringify({ out, summary }));
} finally { db.close(); }

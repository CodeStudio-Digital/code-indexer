import { createHash } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { matchCatalogProviders } from '@mcp/shared/providers/catalog-match.js';
import { abortableRead } from '@mcp/shared/utils/abortable.js';
import type { ProviderName } from '@mcp/shared/types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import type { EmbeddingService } from '../../search/embeddings.js';
import { intentFacts, intentWords, meetsRequirements, type CatalogIntentRequest } from './catalog-intent.js';
import type { CatalogModel, ModelPage } from './model-catalog-read.js';

type Model = CatalogModel & { context_window: number | null; input_modalities: string[] | null; supported_reasoning_levels: string[] | null };
type Entry = { model: Model; description: string; hash: string; words: Set<string> };
type Snapshot = ReturnType<ModelCatalogIndex['readCatalog']>;
type Encoder = Pick<EmbeddingService, 'embed' | 'embedQuery'> & { fingerprint(): string };

// Expand acronyms and terse vendor descriptions into multilingual retrieval text.
// Evidence shown to the agent always comes from the original catalog description.
const terminology: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:ocr|optical character recognition)\b/i, 'read printed words from photographs or scanned pages; ler letras e extrair texto de fotos e documentos digitalizados'],
  [/\b(?:transcription|speech.to.text|automatic speech recognition)\b/i, 'turn a recording into a written transcript; transcrever gravações de voz, passar a fala para texto'],
  [/\b(?:translation model|machine translation)\b/i, 'translate between languages; traduzir documentos e conversas de um idioma para outro'],
  [/\b(?:fill.in.the.middle|code infilling)\b/i, 'complete missing source code between prefix and suffix; completar o código entre prefixo e sufixo'],
  [/\b(?:text embedding|embedding model|sentence embeddings?)\b/i, 'represent sentences as numerical vectors for similarity search; representar frases como vetores para busca semântica'],
  [/\b(?:function calling|tool calling)\b/i, 'invoke external functions and tools; chamar funções e ferramentas externas'],
  [/\b(?:text.to.speech|speech synthesis)\b/i, 'read written text aloud; sintetizar voz a partir de texto'],
];

function finiteVector(values: ArrayLike<number>) {
  if (!values.length || !Array.from(values).every(Number.isFinite)) throw new Error('Invalid catalog embedding');
  return Float32Array.from(values);
}

/** One owner derives a persistent index of the enabled profile's descriptions. Names and verified facts cover every row. */
export class ModelCatalogIndex {
  private snapshot?: Snapshot;
  private vectors = new Map<string, Float32Array>();
  private readonly queries = new Map<string, Float32Array>();
  private encoderId?: string;
  private indexing?: Promise<void>;
  private indexedRevision = -1;
  private retryAfter = 0;
  private closed = false;

  constructor(private readonly db: CodeIndexDB, private readonly encoder?: Encoder) {}

  private revision(): number {
    return this.db.raw().prepare('SELECT revision FROM model_catalog_revision').pluck().get() as number;
  }

  private readCatalog() {
    const store = new ProviderStore(this.db.raw());
    const providers = store.listProviderIdentities();
    const entries: Entry[] = [];
    const documents = new Map<string, string>();
    const frequency = new Map<string, number>();
    for (const p of providers.filter(p => p.enabled)) {
      for (const m of store.listModels(p.id, true)) {
        const id = m.model_id + (m.mode ? '::' + m.mode : '');
        const description = (m.description ?? '').replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 1200);
        const gloss = description ? terminology.filter(([published]) => published.test(description)).map(([,value]) => value).join('. ') : '';
        const document = gloss ? gloss + '. ' + description : description;
        const hash = document ? createHash('sha256').update(document).digest('hex') : '';
        if (hash) documents.set(hash, document);
        const words = new Set(intentWords([id,m.name,m.display_name,document].join(' ')));
        for (const w of words) frequency.set(w, (frequency.get(w) ?? 0) + 1);
        const input_modalities = Array.isArray(m.input_modalities) ? m.input_modalities.filter(x => typeof x === 'string') : null;
        entries.push({ description, hash, words, model: { provider: p.id as ProviderName, id, name: m.name, cached_at: m.updated_at,
          capabilities: ['text'], can_reason: m.can_reason, supported_reasoning_levels: m.supported_reasoning_levels,
          input_modalities, context_window: m.context_window } });
      }
    }
    return { revision: this.revision(), providers, entries, frequency, documents };
  }

  private current() {
    if (this.snapshot?.revision !== this.revision()) this.snapshot = this.db.raw().transaction(() => this.readCatalog())();
    return this.snapshot!;
  }

  /** Idempotent across concurrent queries, process restarts, and provider refreshes that keep the same text. */
  prepare(): Promise<void> {
    if (!this.encoder || this.closed) return Promise.resolve();
    if (this.indexing) return this.indexing;
    const snapshot = this.current();
    if (this.indexedRevision === snapshot.revision) return Promise.resolve();
    const task = this.build(snapshot, this.encoder).then(() => { this.retryAfter = 0; }, e => {
      this.retryAfter = Date.now() + 30_000;
      throw e;
    }).finally(() => { this.indexing = undefined; });
    this.indexing = task;
    return task;
  }

  private async build(snapshot: Snapshot, encoder: Encoder) {
    const db = this.db.raw(), id = encoder.fingerprint();
    if (this.encoderId !== id) {
      this.vectors.clear();
      this.queries.clear();
      this.encoderId = id;
      const stored = db.prepare('SELECT content_hash, vector FROM model_catalog_embeddings WHERE encoder=?').all(id) as {content_hash: string; vector: Buffer}[];
      for (const row of stored) {
        if (snapshot.documents.has(row.content_hash) && row.vector.length && row.vector.length % 4 === 0) {
          const values = new Float32Array(Uint8Array.from(row.vector).buffer);
          if (values.every(Number.isFinite)) this.vectors.set(row.content_hash, values);
        }
      }
    }
    const missing = [...snapshot.documents].filter(([hash]) => !this.vectors.has(hash));
    const write = db.prepare('INSERT OR REPLACE INTO model_catalog_embeddings (encoder,content_hash,vector) VALUES (?,?,?)');
    for (let i = 0; i < missing.length; i += 8) {
      if (this.closed || this.revision() !== snapshot.revision) return;
      const batch = missing.slice(i, i + 8);
      const { vectors } = await encoder.embed(batch.map(([,text]) => text));
      if (this.closed) return;
      if (batch.length !== vectors.length) throw new Error('Incomplete catalog embedding batch');
      const checked = vectors.map(finiteVector);
      db.transaction(() => batch.forEach(([hash], n) => write.run(id, hash, Buffer.from(checked[n].buffer as ArrayBuffer))))();
      batch.forEach(([hash], n) => this.vectors.set(hash, checked[n]));
      await yieldToLoop();
    }
    if (this.closed || this.revision() !== snapshot.revision) return;
    const stored = db.prepare('SELECT content_hash FROM model_catalog_embeddings WHERE encoder=?').pluck().all(id) as string[];
    const remove = db.prepare('DELETE FROM model_catalog_embeddings WHERE encoder=? AND content_hash=?');
    db.transaction(() => { for (const hash of stored) if (!snapshot.documents.has(hash)) remove.run(id, hash); })();
    for (const hash of this.vectors.keys()) if (!snapshot.documents.has(hash)) this.vectors.delete(hash);
    this.indexedRevision = snapshot.revision;
  }

  async search(request: CatalogIntentRequest, signal?: AbortSignal): Promise<ModelPage> {
    signal?.throwIfAborted();
    const initial = this.current();
    const { requires, longContext } = intentFacts(request.query, request.requires);
    const eligible = (snapshot: Snapshot) => {
      const accounts = request.provider ? new Set(matchCatalogProviders(snapshot.providers, request.provider).map(p => p.id)) : undefined;
      return snapshot.entries.filter(({model}) => (!accounts || accounts.has(model.provider)) &&
        meetsRequirements(model, requires) && (!longContext || !!model.context_window));
    };
    let candidates = eligible(initial);
    if (!candidates.length) return { models: [], offset: request.offset, total: 0 };
    // Return verified metadata while a cold index is being built. Never hold an agent turn for backfill.
    if (this.encoder && !this.closed && Date.now() >= this.retryAfter && this.indexedRevision !== initial.revision) {
      void this.prepare().catch(() => undefined);
    }
    let index: NonNullable<ModelPage['search']>['index'] = this.encoder && Date.now() >= this.retryAfter
      ? this.indexedRevision === initial.revision ? 'ready' : 'warming' : 'unavailable';
    let vector: Float32Array | undefined;
    if (index === 'ready' && this.vectors.size && request.query) {
      const key = request.query.trim().toLowerCase();
      vector = this.queries.get(key);
      if (!vector) {
        try {
          const deadline = AbortSignal.timeout(2500);
          const inferenceSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          const result = await abortableRead(() => this.encoder!.embedQuery(key, { signal: inferenceSignal }), inferenceSignal);
          signal?.throwIfAborted();
          vector = finiteVector(result.vector);
          if (this.queries.size >= 64) this.queries.delete(this.queries.keys().next().value!);
          this.queries.set(key, vector);
        } catch {
          signal?.throwIfAborted();
          this.retryAfter = Date.now() + 30_000;
          index = 'unavailable';
        }
      }
    }
    signal?.throwIfAborted();
    // Eligibility can change while ONNX is running. Always rank against the latest profile.
    const snapshot = this.current();
    if (snapshot !== initial) {
      candidates = eligible(snapshot);
      if (index === 'ready') index = 'warming';
    }
    const terms = intentWords(request.query);
    const weights = terms.map(w => Math.log1p(snapshot.entries.length / (1 + (snapshot.frequency.get(w) ?? 0))));
    const totalWeight = weights.reduce((a,b) => a + b, 0) || 1;
    const ranked: Array<{model: Model; score: number; evidence: string}> = [];
    for (const e of candidates) {
      const m = e.model;
      const lexical = terms.reduce((n, t, i) => n + (e.words.has(t) ? weights[i] : 0), 0) / totalWeight;
      let similarity = 0;
      const doc = vector && this.vectors.get(e.hash);
      if (vector && doc && doc.length === vector.length) {
        for (let i = 0; i < doc.length; i++) similarity += vector[i] * doc[i];
      }
      const facts = Object.keys(requires).length > 0 || longContext;
      if (!facts && lexical === 0 && similarity < 0.4) continue;
      const contextScore = longContext ? Math.min(Math.log2(1 + (m.context_window ?? 0) / 8192) / 8, 1) : 0;
      const score = 0.80 * similarity + 0.32 * lexical + 0.30 * contextScore;
      const evidence = (e.description && (similarity >= 0.4 || lexical > 0)) ? e.description.slice(0, 235) :
        [requires.input_modalities?.length && 'input: ' + m.input_modalities?.join(', '),
          (longContext || requires.min_context) && 'context: ' + m.context_window,
          requires.effort && 'effort: ' + requires.effort].filter(Boolean).join(' · ') || m.name;
      ranked.push({ model: m, score, evidence });
    }
    ranked.sort((a,b) => b.score - a.score || a.model.provider.localeCompare(b.model.provider) || a.model.id.localeCompare(b.model.id));
    const { offset, limit } = request;
    const models = ranked.slice(offset, offset + limit).map(({model,evidence}) => ({ ...model, evidence }));
    return { models, total: ranked.length, offset, ...(offset + models.length < ranked.length ? { next_offset: offset + models.length } : {}),
      search: { mode: vector ? 'hybrid' : 'metadata', index } };
  }

  async close() {
    this.closed = true;
    await this.indexing?.catch(() => undefined);
  }
}

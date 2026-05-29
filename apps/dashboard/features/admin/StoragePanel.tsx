import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  EMBEDDING_FIELDS,
  VECTOR_STORE_FIELDS,
  RERANKER_FIELDS,
  fetchEmbeddings,
  fetchVectorStores,
  fetchRerankers,
  upsertEmbedding,
  upsertVectorStore,
  upsertReranker,
  type EmbeddingConfig,
  type EmbeddingKind,
  type VectorStoreConfig,
  type VectorStoreKind,
  type RerankerConfig,
  type RerankerKind,
} from './storage-api.js';
import { StorageConfigDialog } from './StorageConfigDialog.js';

const EMBEDDING_KINDS: Array<{ value: EmbeddingKind; label: string }> = [
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'bedrock', label: 'AWS Bedrock (Titan)' },
  { value: 'null', label: 'None (disable vectors)' },
];

const VECTOR_STORE_KINDS: Array<{ value: VectorStoreKind; label: string }> = [
  { value: 'cloudflare', label: 'Cloudflare Vectorize' },
  { value: 'qdrant', label: 'Qdrant (self-hosted)' },
  { value: 'bedrock-opensearch', label: 'AWS OpenSearch (SigV4)' },
  { value: 'pinecone', label: 'Pinecone' },
  { value: 'null', label: 'None (disable search)' },
];

const RERANKER_KINDS: Array<{ value: RerankerKind; label: string }> = [
  { value: 'cloudflare', label: 'Cloudflare Workers AI (bge-reranker)' },
  { value: 'cohere', label: 'Cohere Rerank' },
  { value: 'null', label: 'None (RRF order only)' },
];

/**
 * Mask a config object for display. Any field whose key looks like a secret
 * (matches /key|token|secret/i) is truncated to prefix+elipsis so the admin
 * UI never splatter API keys into the DOM if a future screenshot leaks.
 */
function summarizeConfig(config: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    if (v === null || v === undefined || v === '') continue;
    if (/key|token|secret/i.test(k)) {
      const s = String(v);
      parts.push(`${k}=${s.length > 6 ? `${s.slice(0, 4)}…` : '••••'}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(' · ') || '(no config)';
}

export function StoragePanel() {
  const { t } = useTranslation(['admin', 'common']);
  const [embeddings, setEmbeddings] = useState<EmbeddingConfig[]>([]);
  const [vectorStores, setVectorStores] = useState<VectorStoreConfig[]>([]);
  const [rerankers, setRerankers] = useState<RerankerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingEmbedding, setEditingEmbedding] = useState<Partial<EmbeddingConfig> | null>(null);
  const [editingVectorStore, setEditingVectorStore] = useState<Partial<VectorStoreConfig> | null>(
    null,
  );
  const [editingReranker, setEditingReranker] = useState<Partial<RerankerConfig> | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [emb, vec, rer] = await Promise.all([
        fetchEmbeddings(),
        fetchVectorStores(),
        fetchRerankers(),
      ]);
      setEmbeddings(emb);
      setVectorStores(vec);
      setRerankers(rer);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="space-y-6">
      {/* Embeddings section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> {t('admin:storage.embeddingModels')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('admin:storage.embeddingDesc')}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setEditingEmbedding({
                kind: 'cloudflare',
                enabled: true,
                is_default: false,
                config: {},
              })
            }
          >
            <Plus className="h-4 w-4 mr-2" /> {t('common:actions.add')}
          </Button>
        </div>

        <div className="grid gap-2">
          {loading && embeddings.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>
          )}
          {!loading && embeddings.length === 0 && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground text-center">
                {t('admin:storage.noEmbeddings')}
              </CardContent>
            </Card>
          )}
          {embeddings.map((e) => (
            <Card key={e.id}>
              <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  {e.name}
                  <Badge variant={e.enabled ? 'success' : 'muted'}>
                    {e.enabled ? t('common:status.enabled') : t('common:status.disabled')}
                  </Badge>
                  {e.is_default && <Badge variant="info">{t('common:status.default')}</Badge>}
                  <Badge variant="outline">{e.kind}</Badge>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setEditingEmbedding(e)}>
                  <Pencil className="h-3.5 w-3.5 mr-1" /> {t('common:actions.edit')}
                </Button>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground font-mono break-all">
                {summarizeConfig(e.config)}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Vector stores section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('admin:storage.vectorStores')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('admin:storage.vectorDesc')}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setEditingVectorStore({
                kind: 'cloudflare',
                enabled: true,
                is_default: false,
                config: {},
              })
            }
          >
            <Plus className="h-4 w-4 mr-2" /> {t('common:actions.add')}
          </Button>
        </div>

        <div className="grid gap-2">
          {loading && vectorStores.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>
          )}
          {!loading && vectorStores.length === 0 && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground text-center">
                {t('admin:storage.noVectors')}
              </CardContent>
            </Card>
          )}
          {vectorStores.map((v) => (
            <Card key={v.id}>
              <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  {v.name}
                  <Badge variant={v.enabled ? 'success' : 'muted'}>
                    {v.enabled ? t('common:status.enabled') : t('common:status.disabled')}
                  </Badge>
                  {v.is_default && <Badge variant="info">{t('common:status.default')}</Badge>}
                  <Badge variant="outline">{v.kind}</Badge>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setEditingVectorStore(v)}>
                  <Pencil className="h-3.5 w-3.5 mr-1" /> {t('common:actions.edit')}
                </Button>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground font-mono break-all">
                {summarizeConfig(v.config)}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Rerankers section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Rerankers</h2>
            <p className="text-xs text-muted-foreground">
              Cross-encoder re-scoring applied after hybrid search to boost precision. Optional.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setEditingReranker({
                kind: 'cloudflare',
                enabled: true,
                is_default: true,
                config: {},
              })
            }
          >
            <Plus className="h-4 w-4 mr-2" /> {t('common:actions.add')}
          </Button>
        </div>

        <div className="grid gap-2">
          {loading && rerankers.length === 0 && (
            <div className="text-sm text-muted-foreground">{t('common:actions.loading')}</div>
          )}
          {!loading && rerankers.length === 0 && (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground text-center">
                No rerankers configured — search uses RRF ordering only.
              </CardContent>
            </Card>
          )}
          {rerankers.map((rk) => (
            <Card key={rk.id}>
              <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  {rk.name}
                  <Badge variant={rk.enabled ? 'success' : 'muted'}>
                    {rk.enabled ? t('common:status.enabled') : t('common:status.disabled')}
                  </Badge>
                  {rk.is_default && <Badge variant="info">{t('common:status.default')}</Badge>}
                  <Badge variant="outline">{rk.kind}</Badge>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setEditingReranker(rk)}>
                  <Pencil className="h-3.5 w-3.5 mr-1" /> {t('common:actions.edit')}
                </Button>
              </CardHeader>
              <CardContent className="p-4 pt-0 text-xs text-muted-foreground font-mono break-all">
                {summarizeConfig(rk.config)}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {editingEmbedding && (
        <StorageConfigDialog<EmbeddingKind>
          title="Embedding"
          initial={{
            ...editingEmbedding,
            kind: (editingEmbedding.kind as EmbeddingKind) ?? 'cloudflare',
          }}
          kinds={EMBEDDING_KINDS}
          fieldsByKind={EMBEDDING_FIELDS}
          onClose={() => setEditingEmbedding(null)}
          onSave={async (c) => {
            await upsertEmbedding(c as EmbeddingConfig);
            setEditingEmbedding(null);
            await load();
          }}
        />
      )}
      {editingVectorStore && (
        <StorageConfigDialog<VectorStoreKind>
          title="Vector Store"
          initial={{
            ...editingVectorStore,
            kind: (editingVectorStore.kind as VectorStoreKind) ?? 'cloudflare',
          }}
          kinds={VECTOR_STORE_KINDS}
          fieldsByKind={VECTOR_STORE_FIELDS}
          onClose={() => setEditingVectorStore(null)}
          onSave={async (c) => {
            await upsertVectorStore(c as VectorStoreConfig);
            setEditingVectorStore(null);
            await load();
          }}
        />
      )}
      {editingReranker && (
        <StorageConfigDialog<RerankerKind>
          title="Reranker"
          initial={{
            ...editingReranker,
            kind: (editingReranker.kind as RerankerKind) ?? 'cloudflare',
          }}
          kinds={RERANKER_KINDS}
          fieldsByKind={RERANKER_FIELDS}
          onClose={() => setEditingReranker(null)}
          onSave={async (c) => {
            await upsertReranker(c as RerankerConfig);
            setEditingReranker(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

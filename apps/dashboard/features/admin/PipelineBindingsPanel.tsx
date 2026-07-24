/**
 * Admin panel for pipeline_provider_bindings (migration 080).
 *
 * Lets the operator pick which provider+model+config a consuming pipeline
 * uses. Roles owned by another source of truth (notably Semantic Indexing)
 * are intentionally absent from this catalog.
 *
 * Each catalog entry has a "Comma" pattern:
 *   - Shows the catalog hint (recommended default, description)
 *   - If a binding exists at any scope, shows it inline + Edit/Test/Delete
 *   - "Add binding" opens a dialog with provider+model+scope+config inputs
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Trash2, PlayCircle, AlertTriangle, CheckCircle2, Pencil, Layers, Eraser, Settings2, Wand2, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useConfirm, useNotify } from '../../components/ui/dialog-provider.js';
import {
  type BindingScopeType,
  type BindingTestResult,
  type PipelineBinding,
  type PipelineCatalogEntry,
  type UpsertBindingInput,
  bulkApplyBindings,
  bulkClearBindings,
  deleteBinding,
  fetchBindings,
  patchBinding,
  testBinding,
  upsertBinding,
} from './pipeline-bindings-api.js';
import { fetchProviders, fetchProviderModels } from './api.js';
import type { AdminModel, AdminProvider } from './types.js';
import type { EditorProbeResult } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
import { usePipelineFilter } from './pipeline-filter/usePipelineFilter.js';
import { PipelineFilterBar } from './pipeline-filter/PipelineFilterBar.js';
import { SetupWizard } from './setup-wizard/SetupWizard.js';
import {
  aiCompleteToggleUnset,
  useAiCompleteStore,
} from '../workspace/editor/ai-complete-store.js';

/**
 * State shape for the bulk-apply dialog. Mirrors the single-row edit
 * dialog enough to feel familiar, but the form here represents the
 * change being broadcast across ALL eligible catalog targets.
 */
interface BulkApplyState {
  provider_id: string;
  model_id: string;
  model_mode: string;
  config_json: string;
  scope_type: BindingScopeType;
  scope_id: string;
  enabled: boolean;
  priority: string;
  /** When true, wipes existing global bindings BEFORE applying. */
  wipeFirst: boolean;
  modelsByProvider: Record<string, AdminModel[]>;
  saving: boolean;
  error: string | null;
}

function emptyBulkApplyState(): BulkApplyState {
  return {
    provider_id: '',
    model_id: '',
    model_mode: '',
    config_json: '{}',
    scope_type: 'global',
    scope_id: '',
    enabled: true,
    priority: '0',
    wipeFirst: false,
    modelsByProvider: {},
    saving: false,
    error: null,
  };
}

interface EditingState {
  catalog: PipelineCatalogEntry;
  binding: PipelineBinding | null; // null = new
  draft: {
    provider_id: string;
    model_id: string;
    model_mode: string;
    config_json: string;
    scope_type: BindingScopeType;
    scope_id: string;
    enabled: boolean;
    priority: string;
  };
  modelsByProvider: Record<string, AdminModel[]>;
  saving: boolean;
  error: string | null;
}

function emptyDraft(catalog: PipelineCatalogEntry): EditingState['draft'] {
  const recommended = catalog.recommendedDefault?.config ?? {};
  const config = catalog.pipelineName === 'editor' && catalog.bindingRole === 'autocomplete'
    ? { ...recommended, context_engine: 'v3', ctx_related_code: true, ctx_related_code_consent_v: 1 }
    : recommended;
  return {
    provider_id: '',
    model_id: '',
    model_mode: '',
    config_json: JSON.stringify(config, null, 2),
    scope_type: 'global',
    scope_id: '',
    enabled: true,
    priority: '0',
  };
}

function draftFromBinding(b: PipelineBinding): EditingState['draft'] {
  return {
    provider_id: b.provider_id,
    model_id: b.model_id,
    model_mode: b.model_mode,
    config_json: JSON.stringify(b.config ?? {}, null, 2),
    scope_type: b.scope_type,
    scope_id: b.scope_id?.toString() ?? '',
    enabled: b.enabled,
    priority: String(b.priority),
  };
}

const PIPELINE_LABELS: Record<string, string> = {
  indexer_search: 'Busca de código',
  snapshot_review: 'Revisão de snapshot',
  doc_ingest: 'Ingestão de documentação',
  doc_search: 'Busca em documentação',
  docs_research: 'Pesquisa em documentação',
  memory_extraction: 'Extração de memória',
  memory_recall: 'Filtro de memórias',
  memory_query: 'Query de recall de memórias',
  goal_verification: 'Verificação de conclusão',
  'code-agent': 'Chat e multimodal',
  editor: 'Editor',
};

const ROLE_LABELS: Record<string, string> = {
  reranker: 'Reranking',
  hyde: 'Expansão HyDE',
  classifier: 'Classificador',
  scorer_llm: 'LLM principal',
  reviewer: 'Revisor',
  link_extractor: 'Extrator de links',
  distiller: 'Destilador',
  vision: 'Visão',
  transcription: 'Transcrição',
  preflight: 'Pré-análise',
  fallback: 'Fallback',
  planner: 'Planejamento',
  summarizer: 'Resumo',
  rewriter: 'Reescrita de consulta',
  query_writer: 'Escritor de query',
};

function pipelineLabel(entry: PipelineCatalogEntry): string {
  return PIPELINE_LABELS[entry.pipelineName] ?? entry.pipelineName.replace(/[-_]/g, ' ');
}

function roleLabel(entry: PipelineCatalogEntry): string {
  return ROLE_LABELS[entry.bindingRole] ?? entry.bindingRole.replace(/[-_]/g, ' ');
}

function bindingSummary(row: PipelineBinding): string {
  const provider = row.provider_name ?? row.provider_id;
  const kind = row.provider_kind ? `${row.provider_kind}/` : '';
  const mode = row.model_mode ? ` · ${row.model_mode}` : '';
  return `${kind}${provider} · ${row.model_id}${mode}`;
}

function configSummary(config: Record<string, unknown>): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' · ');
}

function completionSuitability(row: PipelineBinding): 'native-fim' | 'template-fim' | 'verified-fast-chat' | 'best-effort-chat' {
  const reasoningOnly = /(reasoner|\br1\b|-r1|think)/i.test(row.model_id) && row.config?.fim !== true;
  if (!reasoningOnly && (row.config?.fim === true || row.provider_kind === 'deepseek' || /deepseek-coder|codestral|devstral/i.test(row.model_id))) return 'native-fim';
  if (row.config?.fim !== false && /qwen[\d.]*-?coder|starcoder|stable-?code|codegemma|\bfim\b/i.test(row.model_id)) return 'template-fim';
  const probe = row.config?.completion_probe as { passed?: boolean; prompts?: number } | undefined;
  return probe?.passed && (probe.prompts ?? 0) >= 3 ? 'verified-fast-chat' : 'best-effort-chat';
}

function hasRelatedCodeConsent(configJson: string): boolean {
  try {
    const cfg = JSON.parse(configJson) as Record<string, unknown>;
    return cfg.ctx_related_code === true && cfg.ctx_related_code_consent_v === 1;
  } catch { return false; }
}

export function PipelineBindingsPanel() {
  const { t } = useTranslation(['admin', 'common']);
  const notify = useNotify();
  const confirm = useConfirm();
  const [bindings, setBindings] = useState<PipelineBinding[]>([]);
  const [catalog, setCatalog] = useState<PipelineCatalogEntry[]>([]);
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [testResults, setTestResults] = useState<Record<number, BindingTestResult>>({});
  const [completionProbeResults, setCompletionProbeResults] = useState<Record<number, EditorProbeResult>>({});
  const [busy, setBusy] = useState<number | null>(null);
  /** Bulk-apply dialog state. `null` = closed. */
  const [bulkApply, setBulkApply] = useState<BulkApplyState | null>(null);
  /** Bulk-clear in-flight flag (the panel uses useConfirm() for the dialog itself). */
  const [bulkClearing, setBulkClearing] = useState(false);
  /** Guided-setup wizard open state. */
  const [setupOpen, setSetupOpen] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [bindingsRes, providersRes] = await Promise.all([
        fetchBindings(),
        fetchProviders(),
      ]);
      setBindings(bindingsRes.bindings);
      setCatalog(bindingsRes.catalog);
      setProviders(providersRes);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /** Group bindings by (pipeline_name, binding_role) for layout. */
  const grouped = useMemo(() => {
    const map = new Map<string, { catalog: PipelineCatalogEntry; rows: PipelineBinding[] }>();
    for (const entry of catalog) {
      // Embedding/reranking entries owned by Semantic Indexing are not
      // pipeline settings. Hide empty informational rows instead of offering
      // a control that the runtime will never read.
      if (entry.setupEligible === false) continue;
      const key = `${entry.pipelineName}::${entry.bindingRole}`;
      map.set(key, { catalog: entry, rows: [] });
    }
    for (const b of bindings) {
      const key = `${b.pipeline_name}::${b.binding_role}`;
      const bucket = map.get(key);
      if (bucket) bucket.rows.push(b);
      else {
        // Unknown custom bindings remain configurable. A known informational
        // binding is legacy data: render it read-only so it can be deleted.
        const catalogEntry = catalog.find((entry) =>
          entry.pipelineName === b.pipeline_name && entry.bindingRole === b.binding_role);
        map.set(key, {
          catalog: catalogEntry ?? {
            pipelineName: b.pipeline_name,
            bindingRole: b.binding_role,
            description: t('admin:pipelines.customDescription'),
            introducedInPhase: '-',
          },
          rows: [b],
        });
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [bindings, catalog, t]);

  const filter = usePipelineFilter(grouped, (c) => `${pipelineLabel(c)} ${roleLabel(c)}`);

  const openNew = (entry: PipelineCatalogEntry) => {
    setEditing({
      catalog: entry,
      binding: null,
      draft: emptyDraft(entry),
      modelsByProvider: {},
      saving: false,
      error: null,
    });
  };

  const openEdit = (entry: PipelineCatalogEntry, binding: PipelineBinding) => {
    setEditing({
      catalog: entry,
      binding,
      draft: draftFromBinding(binding),
      modelsByProvider: {},
      saving: false,
      error: null,
    });
    void fetchProviderModels(binding.provider_id)
      .then((models) => {
        setEditing((s) =>
          s?.binding?.id === binding.id
            ? { ...s, modelsByProvider: { ...s.modelsByProvider, [binding.provider_id]: models } }
            : s,
        );
      })
      .catch((e) => {
        setEditing((s) =>
          s?.binding?.id === binding.id
            ? { ...s, error: t('admin:pipelines.loadModelsFailed', { message: (e as Error).message }) }
            : s,
        );
      });
  };

  const onProviderSelected = async (providerId: string) => {
    setEditing((s) => s ? { ...s, draft: { ...s.draft, provider_id: providerId, model_id: '', model_mode: '' } } : s);
    if (!editing) return;
    if (editing.modelsByProvider[providerId]) return;
    try {
      const models = await fetchProviderModels(providerId);
      setEditing((s) => s ? { ...s, modelsByProvider: { ...s.modelsByProvider, [providerId]: models } } : s);
    } catch (e) {
      setEditing((s) => s ? { ...s, error: t('admin:pipelines.loadModelsFailed', { message: (e as Error).message }) } : s);
    }
  };

  const onSubmit = async () => {
    if (!editing) return;
    let configParsed: Record<string, unknown> = {};
    try {
      configParsed = JSON.parse(editing.draft.config_json || '{}');
      if (typeof configParsed !== 'object' || Array.isArray(configParsed) || configParsed === null) {
        throw new Error(t('admin:pipelines.errors.configNotObject'));
      }
    } catch (e) {
      setEditing((s) => s ? { ...s, error: t('admin:pipelines.errors.invalidConfig', { message: (e as Error).message }) } : s);
      return;
    }
    if (!editing.draft.provider_id) {
      setEditing((s) => s ? { ...s, error: t('admin:pipelines.errors.providerRequired') } : s);
      return;
    }
    if (!editing.draft.model_id) {
      setEditing((s) => s ? { ...s, error: t('admin:pipelines.errors.modelRequired') } : s);
      return;
    }
    if (editing.draft.scope_type !== 'global' && !editing.draft.scope_id) {
      setEditing((s) => s ? { ...s, error: t('admin:pipelines.errors.scopeIdRequired') } : s);
      return;
    }

    setEditing((s) => s ? { ...s, saving: true, error: null } : s);

    const input: UpsertBindingInput = {
      pipeline_name: editing.catalog.pipelineName,
      binding_role:  editing.catalog.bindingRole,
      provider_id:   editing.draft.provider_id,
      model_id:      editing.draft.model_id,
      model_mode:    editing.draft.model_mode || undefined,
      config:        configParsed,
      scope_type:    editing.draft.scope_type,
      scope_id:      editing.draft.scope_type === 'global'
        ? null
        : Number(editing.draft.scope_id) || null,
      enabled:       editing.draft.enabled,
      priority:      Number(editing.draft.priority) || 0,
    };

    try {
      if (editing.binding) {
        await patchBinding(editing.binding.id, input);
      } else {
        await upsertBinding(input);
      }
      setEditing(null);
      await load();
    } catch (e) {
      setEditing((s) => s ? { ...s, saving: false, error: (e as Error).message } : s);
    }
  };

  const onToggleEnabled = async (binding: PipelineBinding) => {
    setBusy(binding.id);
    try {
      await patchBinding(binding.id, { enabled: !binding.enabled });
      await load();
    } catch (e) {
      await notify({ title: t('admin:pipelines.toggleFailed'), description: (e as Error).message, variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const onTest = async (binding: PipelineBinding) => {
    setBusy(binding.id);
    setTestResults((prev) => ({ ...prev, [binding.id]: { ok: false, reason: t('admin:pipelines.testing') } }));
    try {
      const result = await testBinding(binding.id);
      setTestResults((t) => ({ ...t, [binding.id]: result }));
    } finally {
      setBusy(null);
    }
  };

  const onCompletionProbe = async (binding: PipelineBinding) => {
    setBusy(binding.id);
    try {
      const result = await apiCall<EditorProbeResult>('editor.probe', { bindingId: binding.id });
      setCompletionProbeResults((prev) => ({ ...prev, [binding.id]: result }));
      await load(); // successful probes persist their compatibility stamp
    } finally { setBusy(null); }
  };

  const setRelatedConsent = (enabled: boolean) => {
    setEditing((state) => {
      if (!state) return state;
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(state.draft.config_json || '{}') as Record<string, unknown>; } catch { /* keep visible parse error for submit */ }
      cfg.ctx_related_code = enabled;
      if (enabled) cfg.ctx_related_code_consent_v = 1;
      else delete cfg.ctx_related_code_consent_v;
      return { ...state, draft: { ...state.draft, config_json: JSON.stringify(cfg, null, 2) } };
    });
  };

  const onDelete = async (binding: PipelineBinding) => {
    const ok = await confirm({
      title: t('admin:pipelines.delete.title'),
      description: `${binding.pipeline_name}/${binding.binding_role} → ${binding.provider_id}/${binding.model_id}`,
      variant: 'destructive',
      confirmLabel: t('admin:pipelines.delete.confirm'),
    });
    if (!ok) return;
    setBusy(binding.id);
    try {
      await deleteBinding(binding.id);
      await load();
    } finally {
      setBusy(null);
    }
  };

  // ─── Bulk operations ─────────────────────────────────────────────────

  /** Open the bulk-apply dialog (single source for "set one model on all"). */
  const openBulkApply = () => setBulkApply(emptyBulkApplyState());

  /** Provider picker inside the bulk dialog reuses the same async-load pattern
   *  the single-binding edit dialog uses — fetch models lazily, then cache
   *  them under modelsByProvider. */
  const onBulkProviderSelected = async (providerId: string) => {
    setBulkApply((s) => (s ? { ...s, provider_id: providerId, model_id: '', model_mode: '' } : s));
    if (!bulkApply) return;
    if (bulkApply.modelsByProvider[providerId]) return;
    try {
      const models = await fetchProviderModels(providerId);
      setBulkApply((s) =>
        s ? { ...s, modelsByProvider: { ...s.modelsByProvider, [providerId]: models } } : s,
      );
    } catch (e) {
      setBulkApply((s) => (s ? { ...s, error: `Failed to load models: ${(e as Error).message}` } : s));
    }
  };

  /** Validate + submit the bulk-apply form. The two server calls (clear,
   *  then apply) run sequentially so a failed clear doesn't double-up
   *  bindings; on apply failure we surface the error and leave the (now
   *  cleared) DB in a known state. */
  const onBulkApplySubmit = async () => {
    if (!bulkApply) return;
    let configParsed: Record<string, unknown> = {};
    try {
      configParsed = JSON.parse(bulkApply.config_json || '{}');
      if (typeof configParsed !== 'object' || Array.isArray(configParsed) || configParsed === null) {
        throw new Error(t('admin:pipelines.bulkDialog.errors.configNotObject'));
      }
    } catch (e) {
      setBulkApply((s) =>
        s ? { ...s, error: t('admin:pipelines.bulkDialog.errors.invalidConfig', { message: (e as Error).message }) } : s,
      );
      return;
    }
    if (!bulkApply.provider_id) {
      setBulkApply((s) => (s ? { ...s, error: t('admin:pipelines.bulkDialog.errors.providerRequired') } : s));
      return;
    }
    if (!bulkApply.model_id) {
      setBulkApply((s) => (s ? { ...s, error: t('admin:pipelines.bulkDialog.errors.modelRequired') } : s));
      return;
    }
    if (bulkApply.scope_type !== 'global' && !bulkApply.scope_id) {
      setBulkApply((s) => (s ? { ...s, error: t('admin:pipelines.bulkDialog.errors.scopeIdRequired') } : s));
      return;
    }

    setBulkApply((s) => (s ? { ...s, saving: true, error: null } : s));

    try {
      let clearedCount = 0;
      if (bulkApply.wipeFirst) {
        const result = await bulkClearBindings({ scope_type: bulkApply.scope_type });
        clearedCount = result.removed;
      }
      const result = await bulkApplyBindings({
        provider_id: bulkApply.provider_id,
        model_id: bulkApply.model_id,
        model_mode: bulkApply.model_mode || undefined,
        config: configParsed,
        scope_type: bulkApply.scope_type,
        scope_id: bulkApply.scope_type === 'global' ? null : Number(bulkApply.scope_id) || null,
        enabled: bulkApply.enabled,
        priority: Number(bulkApply.priority) || 0,
      });
      setBulkApply(null);
      await load();
      await notify({
        title: t('admin:pipelines.bulk.applied.title'),
        description: bulkApply.wipeFirst
          ? t('admin:pipelines.bulk.applied.descriptionWithClear', { cleared: clearedCount, applied: result.applied })
          : t('admin:pipelines.bulk.applied.description', { applied: result.applied }),
      });
    } catch (e) {
      setBulkApply((s) => (s ? { ...s, saving: false, error: (e as Error).message } : s));
    }
  };

  /** Wipe-all confirmation: two-step (confirm dialog, then explicit POST
   *  with the `wipe-all` sentinel the server requires). The dialog
   *  description lists exactly how many rows will be removed so the
   *  operator isn't surprised. */
  const onBulkClearAll = async () => {
    const totalBindings = bindings.length;
    if (totalBindings === 0) {
      await notify({
        title: t('admin:pipelines.bulk.nothingToClear.title'),
        description: t('admin:pipelines.bulk.nothingToClear.description'),
      });
      return;
    }
    const ok = await confirm({
      title: t('admin:pipelines.bulk.confirmClear.title'),
      description: t('admin:pipelines.bulk.confirmClear.description', { count: totalBindings }),
      variant: 'destructive',
      confirmLabel: t('admin:pipelines.bulk.confirmClear.confirm'),
    });
    if (!ok) return;
    setBulkClearing(true);
    try {
      const result = await bulkClearBindings({ confirm: 'wipe-all' });
      await load();
      await notify({
        title: t('admin:pipelines.bulk.cleared.title'),
        description: t('admin:pipelines.bulk.cleared.description', { count: result.removed }),
      });
    } catch (e) {
      await notify({
        title: t('admin:pipelines.bulk.clearFailed'),
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setBulkClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm text-muted-foreground max-w-3xl">
          {t('admin:pipelines.subtitle')}
        </div>
        {/* Bulk-edit toolbar — sits next to the description so it's visible
            without scrolling. The two actions are intentionally separate
            (apply vs. clear) because they require different confirmations
            and target sets. */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            onClick={() => setSetupOpen(true)}
            disabled={loading}
            title={t('admin:pipelines.setup.openTitle')}
          >
            <Wand2 className="h-3.5 w-3.5 mr-1.5" /> {t('admin:pipelines.setup.open')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={openBulkApply}
            disabled={loading || bulkClearing}
            title={t('admin:pipelines.bulk.applyTitle')}
          >
            <Layers className="h-3.5 w-3.5 mr-1.5" /> {t('admin:pipelines.bulk.apply')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onBulkClearAll()}
            disabled={loading || bulkClearing || bindings.length === 0}
            title={t('admin:pipelines.bulk.clearTitle')}
            className="text-red-600 hover:text-red-700 hover:bg-red-500/10 border-red-500/30"
          >
            {bulkClearing ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Eraser className="h-3.5 w-3.5 mr-1.5" />
            )}
            {t('admin:pipelines.bulk.clear')}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('admin:pipelines.loading')}
        </div>
      )}
      {error && (
        <div className="text-sm text-red-500 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {!loading && <PipelineFilterBar filter={filter} />}

      <div className="grid gap-3 xl:grid-cols-2">
        {filter.visibleGroups.map(([key, group]) => {
          const configurable = group.catalog.setupEligible !== false;
          const enabledCount = group.rows.filter((r) => r.enabled).length;
          const statusVariant = !configurable ? 'warning' : group.catalog.comingSoon ? 'warning' : enabledCount > 0 ? 'success' : 'muted';
          const statusLabel = !configurable
            ? t('admin:pipelines.status.ignoredLegacy')
            : group.catalog.comingSoon
            ? t('admin:pipelines.status.preconfigurable')
            : enabledCount > 0
              ? t('admin:pipelines.status.configured')
              : t('admin:pipelines.status.notConfigured');
          return (
            <Card key={key} className="border bg-card/70">
              <CardHeader className="space-y-3 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <CardTitle className="text-base leading-tight flex flex-wrap items-center gap-2">
                      <span>{pipelineLabel(group.catalog)}</span>
                      <Badge variant="secondary" className="normal-case tracking-normal">
                        {roleLabel(group.catalog)}
                      </Badge>
                      <Badge variant={statusVariant} className="normal-case tracking-normal">
                        {statusLabel}
                      </Badge>
                    </CardTitle>
                    <div className="text-[11px] text-muted-foreground font-mono truncate">
                      {group.catalog.pipelineName} / {group.catalog.bindingRole}
                    </div>
                  </div>
                  {configurable && (
                    <Button size="sm" variant={group.rows.length === 0 ? 'default' : 'outline'} onClick={() => openNew(group.catalog)}>
                      <Plus className="h-3 w-3 mr-1" /> {group.rows.length === 0 ? t('admin:pipelines.configure') : t('admin:pipelines.addBinding')}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {group.catalog.description}
                </p>
                {group.catalog.recommendedDefault && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{t('admin:pipelines.suggested')}</span>
                    <Badge variant="outline" className="normal-case tracking-normal font-mono">
                      {group.catalog.recommendedDefault.providerKind} / {group.catalog.recommendedDefault.modelHint}
                    </Badge>
                  </div>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                {group.rows.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
                    {t('admin:pipelines.noBinding')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {group.rows.map((row) => {
                      const test = testResults[row.id];
                      const completionProbe = completionProbeResults[row.id];
                      const isCompletion = row.pipeline_name === 'editor' && row.binding_role === 'autocomplete';
                      const configText = configSummary(row.config ?? {});
                      return (
                        <div key={row.id} className="rounded-lg border bg-background/60 p-3 text-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant={row.enabled ? 'success' : 'muted'} className="normal-case tracking-normal">
                                  {row.enabled ? t('admin:pipelines.enabled') : t('admin:pipelines.disabled')}
                                </Badge>
                                <Badge variant="outline" className="normal-case tracking-normal">
                                  {row.scope_type}{row.scope_id != null && row.scope_type !== 'global' ? ` #${row.scope_id}` : ''}
                                </Badge>
                                <Badge variant="outline" className="normal-case tracking-normal">
                                  {t('admin:pipelines.priorityShort', { priority: row.priority })}
                                </Badge>
                                {isCompletion && (
                                  <Badge variant={completionSuitability(row) === 'best-effort-chat' ? 'warning' : 'success'} className="normal-case tracking-normal">
                                    {completionSuitability(row)}
                                  </Badge>
                                )}
                              </div>
                              <div className="font-medium truncate">{bindingSummary(row)}</div>
                              {configText && (
                                <div className="text-[11px] text-muted-foreground font-mono truncate">
                                  <Settings2 className="inline h-3 w-3 mr-1 align-[-2px]" />
                                  {configText}
                                </div>
                              )}
                              {test && (
                                <div className={`text-xs ${test.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                                  {test.ok ? (
                                    <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> {test.model?.name ?? 'OK'}</span>
                                  ) : (
                                    <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {test.reason}</span>
                                  )}
                                </div>
                              )}
                              {completionProbe && (
                                <div className={`text-xs ${completionProbe.verifiedForAutomatic ? 'text-emerald-600' : 'text-amber-600'}`}>
                                  {completionProbe.message} {t('admin:pipelines.completionProbeMetrics', { p50: completionProbe.latency.p50 ?? '—', p90: completionProbe.latency.p90 ?? '—' })}
                                  {completionProbe.route && ` · ${completionProbe.route.transport} · ${completionProbe.route.health}`}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {configurable && (
                                <>
                                  <Switch checked={row.enabled} onCheckedChange={() => onToggleEnabled(row)} disabled={busy === row.id} />
                                  <Button size="sm" variant="ghost" onClick={() => openEdit(group.catalog, row)} disabled={busy === row.id} title={t('admin:pipelines.dialog.editTitle')}>
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => onTest(row)} disabled={busy === row.id} title={t('admin:pipelines.test')}>
                                    <PlayCircle className="h-3 w-3" />
                                  </Button>
                                  {isCompletion && (
                                    <Button size="sm" variant="ghost" onClick={() => void onCompletionProbe(row)} disabled={busy === row.id} title={t('admin:pipelines.completionProbeTitle')}>
                                      <Sparkles className="h-3 w-3" />
                                    </Button>
                                  )}
                                </>
                              )}
                              <Button size="sm" variant="ghost" onClick={() => onDelete(row)} disabled={busy === row.id} title={t('common:actions.delete')}>
                                <Trash2 className="h-3 w-3 text-red-500" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!loading && !error && filter.shown === 0 && (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          {t('admin:pipelines.filter.empty')}
          <Button variant="link" size="sm" onClick={filter.reset} className="ml-1 h-auto p-0 align-baseline">
            {t('admin:pipelines.filter.clear')}
          </Button>
        </div>
      )}

      <SetupWizard
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onApplied={() => {
          void load();
          // Guided setup that bound editor/autocomplete = informed consent →
          // auto-enable ghost text, but only when the user NEVER touched the
          // toggle (an explicit '0' is an explicit no).
          void (async () => {
            try {
              if (!aiCompleteToggleUnset()) return;
              const { bindings } = await fetchBindings({ pipelineName: 'editor', enabledOnly: true });
              if (bindings.some((b) => b.binding_role === 'autocomplete')) {
                useAiCompleteStore.getState().setEnabled(true);
                useAiCompleteStore.getState().requestNudge('enabled-hint');
              }
            } catch { /* best-effort */ }
          })();
        }}
      />

      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>
                {editing.binding ? t('admin:pipelines.dialog.editTitle') : t('admin:pipelines.dialog.newTitle')} — {pipelineLabel(editing.catalog)} · {roleLabel(editing.catalog)}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2 text-sm">
              <div>
                <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.provider')}</label>
                <select
                  className="w-full border rounded px-2 py-1 bg-background"
                  value={editing.draft.provider_id}
                  onChange={(e) => void onProviderSelected(e.target.value)}
                >
                  <option value="">{t('admin:pipelines.dialog.providerPlaceholder')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.kind})
                      {p.enabled ? '' : ' [disabled]'}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.model')}</label>
                  <select
                    className="w-full border rounded px-2 py-1 bg-background"
                    value={editing.draft.model_id}
                    onChange={(e) =>
                      setEditing((s) => s ? { ...s, draft: { ...s.draft, model_id: e.target.value } } : s)
                    }
                    disabled={!editing.draft.provider_id}
                  >
                    <option value="">{t('admin:pipelines.dialog.modelPlaceholder')}</option>
                    {(editing.modelsByProvider[editing.draft.provider_id] ?? []).map((m) => (
                      <option key={`${m.model_id}:${m.mode}`} value={m.model_id}>
                        {m.name} {m.mode ? `(${m.mode})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.mode')}</label>
                  <Input
                    value={editing.draft.model_mode}
                    onChange={(e) =>
                      setEditing((s) => s ? { ...s, draft: { ...s.draft, model_mode: e.target.value } } : s)
                    }
                    placeholder=""
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.scope')}</label>
                  <select
                    className="w-full border rounded px-2 py-1 bg-background"
                    value={editing.draft.scope_type}
                    onChange={(e) =>
                      setEditing((s) =>
                        s
                          ? { ...s, draft: { ...s.draft, scope_type: e.target.value as BindingScopeType } }
                          : s,
                      )
                    }
                  >
                    <option value="global">global</option>
                    <option value="template">template</option>
                    <option value="session">session</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.scopeId')}</label>
                  <Input
                    value={editing.draft.scope_id}
                    disabled={editing.draft.scope_type === 'global'}
                    onChange={(e) =>
                      setEditing((s) => s ? { ...s, draft: { ...s.draft, scope_id: e.target.value } } : s)
                    }
                    placeholder={editing.draft.scope_type === 'global' ? '—' : '123'}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.priority')}</label>
                  <Input
                    value={editing.draft.priority}
                    onChange={(e) =>
                      setEditing((s) => s ? { ...s, draft: { ...s.draft, priority: e.target.value } } : s)
                    }
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1">{t('admin:pipelines.dialog.config')}</label>
                <Textarea
                  rows={5}
                  value={editing.draft.config_json}
                  onChange={(e) =>
                    setEditing((s) => s ? { ...s, draft: { ...s.draft, config_json: e.target.value } } : s)
                  }
                  className="font-mono text-xs"
                />
              </div>

              {editing.catalog.pipelineName === 'editor' && editing.catalog.bindingRole === 'autocomplete' && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                  <div className="flex items-center gap-2">
                    <Switch checked={hasRelatedCodeConsent(editing.draft.config_json)} onCheckedChange={setRelatedConsent} />
                    <span className="text-xs font-medium">{t('admin:pipelines.relatedCodeConsent.label')}</span>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                    {t('admin:pipelines.relatedCodeConsent.description')}
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Switch
                  checked={editing.draft.enabled}
                  onCheckedChange={(v: boolean) =>
                    setEditing((s) => s ? { ...s, draft: { ...s.draft, enabled: v } } : s)
                  }
                />
                <span className="text-sm">{t('admin:pipelines.dialog.enabled')}</span>
              </div>

              {editing.error && (
                <div className="text-xs text-red-500 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {editing.error}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)} disabled={editing.saving}>
                {t('admin:pipelines.dialog.cancel')}
              </Button>
              <Button onClick={() => void onSubmit()} disabled={editing.saving}>
                {editing.saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {editing.binding ? t('admin:pipelines.dialog.save') : t('admin:pipelines.dialog.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Bulk-apply dialog. Same shape as the single-row edit but every
          field describes the change being broadcast across the entire
          catalog. The `wipeFirst` toggle adds a clearing step before the
          apply — convenient when you're switching providers wholesale. */}
      {bulkApply && (
        <Dialog open onOpenChange={(open) => !open && setBulkApply(null)}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Layers className="h-4 w-4" />
                {t('admin:pipelines.bulkDialog.title')}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-md border bg-amber-500/10 border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {t('admin:pipelines.bulkDialog.notice')}
              </div>

              <div>
                <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.provider')}</label>
                <select
                  className="w-full border rounded px-2 py-1 bg-background"
                  value={bulkApply.provider_id}
                  onChange={(e) => void onBulkProviderSelected(e.target.value)}
                >
                  <option value="">{t('admin:pipelines.bulkDialog.providerPlaceholder')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.kind}){p.enabled ? '' : ` [${t('admin:provider.disabled')}]`}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.model')}</label>
                  <select
                    className="w-full border rounded px-2 py-1 bg-background"
                    value={bulkApply.model_id}
                    onChange={(e) =>
                      setBulkApply((s) => (s ? { ...s, model_id: e.target.value } : s))
                    }
                    disabled={!bulkApply.provider_id}
                  >
                    <option value="">{t('admin:pipelines.bulkDialog.modelPlaceholder')}</option>
                    {(bulkApply.modelsByProvider[bulkApply.provider_id] ?? []).map((m) => (
                      <option key={`${m.model_id}:${m.mode}`} value={m.model_id}>
                        {m.name} {m.mode ? `(${m.mode})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.mode')}</label>
                  <Input
                    value={bulkApply.model_mode}
                    onChange={(e) =>
                      setBulkApply((s) => (s ? { ...s, model_mode: e.target.value } : s))
                    }
                    placeholder=""
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.scope')}</label>
                  <select
                    className="w-full border rounded px-2 py-1 bg-background"
                    value={bulkApply.scope_type}
                    onChange={(e) =>
                      setBulkApply((s) =>
                        s
                          ? { ...s, scope_type: e.target.value as BindingScopeType }
                          : s,
                      )
                    }
                  >
                    <option value="global">global</option>
                    <option value="template">template</option>
                    <option value="session">session</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.scopeId')}</label>
                  <Input
                    value={bulkApply.scope_id}
                    disabled={bulkApply.scope_type === 'global'}
                    onChange={(e) =>
                      setBulkApply((s) => (s ? { ...s, scope_id: e.target.value } : s))
                    }
                    placeholder={bulkApply.scope_type === 'global' ? '—' : '123'}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.priority')}</label>
                  <Input
                    value={bulkApply.priority}
                    onChange={(e) =>
                      setBulkApply((s) => (s ? { ...s, priority: e.target.value } : s))
                    }
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1">{t('admin:pipelines.bulkDialog.config')}</label>
                <Textarea
                  rows={4}
                  value={bulkApply.config_json}
                  onChange={(e) =>
                    setBulkApply((s) => (s ? { ...s, config_json: e.target.value } : s))
                  }
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={bulkApply.enabled}
                  onCheckedChange={(v: boolean) =>
                    setBulkApply((s) => (s ? { ...s, enabled: v } : s))
                  }
                />
                <span className="text-sm">{t('admin:pipelines.bulkDialog.enabled')}</span>
              </div>

              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2">
                <Switch
                  checked={bulkApply.wipeFirst}
                  onCheckedChange={(v: boolean) =>
                    setBulkApply((s) => (s ? { ...s, wipeFirst: v } : s))
                  }
                />
                <div className="text-xs">
                  <div className="font-medium text-red-700 dark:text-red-300">
                    {t('admin:pipelines.bulkDialog.wipeFirst.title')}
                  </div>
                  <div className="text-muted-foreground">
                    {t('admin:pipelines.bulkDialog.wipeFirst.description')}
                  </div>
                </div>
              </div>

              {bulkApply.error && (
                <div className="text-xs text-red-500 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {bulkApply.error}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setBulkApply(null)} disabled={bulkApply.saving}>
                {t('admin:pipelines.bulkDialog.cancel')}
              </Button>
              <Button
                onClick={() => void onBulkApplySubmit()}
                disabled={bulkApply.saving || !bulkApply.provider_id || !bulkApply.model_id}
              >
                {bulkApply.saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Layers className="h-4 w-4 mr-1" />}
                {t('admin:pipelines.bulkDialog.submit')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, RefreshCw, Trash2, XCircle, Zap } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Switch } from '../../components/ui/switch.js';
import { SubagentProfilesPanel } from './SubagentProfilesPanel.js';
import { AddModelForm, type AddModelInput } from './providers/AddModelForm.js';
import { SubagentTargetSelect } from './providers/SubagentTargetSelect.js';
import type { AdminModel, AdminProvider, TestResult } from './types.js';

interface ProviderCardProps {
  provider: AdminProvider;
  allProviders: AdminProvider[];
  isExpanded: boolean;
  models: AdminModel[];
  providerModelsById: Record<string, AdminModel[]>;
  testResult: TestResult | undefined;
  refreshing: boolean;
  onTest: () => void;
  onToggleExpand: () => void;
  onLoadProviderModels: (providerId: string) => void | Promise<void>;
  onRefresh: () => void;
  onEdit: () => void;
  onConnect?: () => void;
  onRemove: () => void;
  onToggleModel: (modelId: string, mode: string, enabled: boolean) => void;
  onAddModel: (input: AddModelInput) => void;
  onDeleteModel: (modelId: string, mode: string) => void;
  onSetModelEffort: (modelId: string, mode: string, level: string | null) => void;
  onSetModelContextWindow: (modelId: string, mode: string, value: number | null) => void;
  onSetModelMaxOutputTokens: (modelId: string, mode: string, value: number | null) => void;
  onSetModelMaxTools: (modelId: string, mode: string, value: number | null) => void;
  onBackfillContextWindows: () => void;
  onSetSubagentTarget: (
    providerId: string,
    subagentProviderId: string | null,
    modelId: string | null,
    profile?: string,
  ) => void;
  onSetSubagentEffort: (
    providerId: string,
    effort: string | null,
    profile?: string,
  ) => void;
  onSetSubagentLimits: (
    providerId: string,
    profile: string,
    patch: { maxToolCalls?: number | null; timeoutMs?: number | null },
  ) => void;
}

export function ProviderCard({
  provider: p,
  allProviders,
  isExpanded,
  models,
  providerModelsById,
  testResult: tr,
  refreshing,
  onTest,
  onToggleExpand,
  onLoadProviderModels,
  onRefresh,
  onEdit,
  onConnect,
  onRemove,
  onToggleModel,
  onAddModel,
  onDeleteModel,
  onSetModelEffort,
  onSetModelContextWindow,
  onSetModelMaxOutputTokens,
  onSetModelMaxTools,
  onBackfillContextWindows,
  onSetSubagentTarget,
  onSetSubagentEffort,
  onSetSubagentLimits,
}: ProviderCardProps) {
  const { t } = useTranslation(['admin', 'common']);
  const selectedSubagentProviderId = readSubagentProviderId(p.extra?.subagent_provider_id);
  const selectedSubagentModelId = readSubagentModelId(p.extra?.subagent_model);
  const enabledSubagentProviderOptions = allProviders.filter((candidate) => (
    candidate.id !== p.id && candidate.enabled && candidate.use_for_coder
  ));
  return (
    // `provider-card-shell` is a sentinel class that the new
    // `ProviderModal` uses to strip the outer border/shadow when the
    // card renders inside the dialog body — see `ProviderModal.tsx`.
    // Standalone (grid view) consumers still get the default Card chrome.
    <Card className="provider-card-shell overflow-hidden">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CardTitle className="text-base truncate">{p.name}</CardTitle>
            <Badge variant="outline">{p.kind}</Badge>
            {p.is_default && <Badge>{t('admin:provider.default')}</Badge>}
            {!p.enabled && <Badge variant="secondary">{t('admin:provider.disabled')}</Badge>}
            {p.has_key ? (
              <span className="text-xs text-muted-foreground font-mono">{p.api_key_masked}</span>
            ) : p.auth_mode === 'api_key' ? (
              <span className="text-xs text-amber-600">{t('admin:provider.noKey')}</span>
            ) : null}
            {tr &&
              (tr.ok ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> {tr.latencyMs}ms
                </span>
              ) : tr.error === t('admin:provider.testing') ? (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-600" title={tr.error}>
                  <XCircle className="h-3 w-3" /> {t('admin:provider.fail')}
                </span>
              ))}
          </div>
          <div className="flex items-center gap-1.5">
            {onConnect && (
              <Button size="sm" variant="ghost" onClick={onConnect}>
                {t('admin:provider.connect')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onTest}>
              <Zap className="h-4 w-4 mr-1" /> {t('common:actions.test')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onToggleExpand}>
              {t('admin:provider.models', { count: models.length || '…' })}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t('common:actions.edit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent className="pt-0 border-t bg-muted/20">
          <AddModelForm onAdd={onAddModel} />
          {models.length === 0 ? (
            <div className="py-3 text-sm text-muted-foreground">
              {t('admin:provider.noModels')}
            </div>
          ) : (
            <div className="divide-y">
              {models.map((m) => (
                <div
                  key={`${m.model_id}:${m.mode}`}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium truncate" title={m.model_id}>
                      {m.name || m.model_id}
                    </span>
                    {m.mode && <Badge variant="outline">{m.mode}</Badge>}
                    <Badge variant="secondary" className="text-[10px]">
                      {m.source}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.supported_reasoning_levels &&
                      m.supported_reasoning_levels.length > 0 && (
                        <select
                          aria-label={`Reasoning effort for ${m.model_id}`}
                          className="h-7 rounded border bg-background px-1.5 text-xs"
                          value={m.default_reasoning_level ?? ''}
                          onChange={(e) =>
                            onSetModelEffort(
                              m.model_id,
                              m.mode,
                              e.target.value === '' ? null : e.target.value,
                            )
                          }
                        >
                          <option value="">auto</option>
                          {m.supported_reasoning_levels.map((lv) => {
                            const label = typeof lv === 'string' ? lv : String((lv as Record<string, unknown>)?.effort ?? lv);
                            return (
                              <option key={label} value={label}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    <NumericOverrideField
                      modelId={m.model_id}
                      mode={m.mode}
                      value={m.default_max_tokens}
                      onSet={onSetModelMaxOutputTokens}
                      min={1}
                      placeholder={t('admin:provider.maxOutputTokensPlaceholder')}
                      unknownLabel="auto out"
                      format={(v) => `${formatCtx(v)} out`}
                      titleUnknown="Output limit: automatic (model registry) — click to override"
                      titleValue={(v) => `Output limit: ${v.toLocaleString()} tokens — click to edit`}
                    />
                    <NumericOverrideField
                      modelId={m.model_id}
                      mode={m.mode}
                      value={m.context_window}
                      onSet={onSetModelContextWindow}
                      min={1024}
                      placeholder="e.g. 200000"
                      warnWhenNull
                      unknownLabel="? ctx"
                      format={(v) => `${formatCtx(v)} ctx`}
                      titleUnknown="Context window unknown — click to set manually"
                      titleValue={(v) => `Context window: ${v.toLocaleString()} tokens — click to edit`}
                    />
                    <NumericOverrideField
                      modelId={m.model_id}
                      mode={m.mode}
                      value={m.max_tools}
                      onSet={onSetModelMaxTools}
                      min={4}
                      placeholder={t('admin:provider.maxToolsPlaceholder')}
                      unknownLabel="auto tools"
                      format={(v) => `${v} tools`}
                      titleUnknown="Tool catalog cap: automatic (registry default) — click to override"
                      titleValue={(v) => `Tool catalog cap: ${v} tools per turn — click to edit`}
                    />
                    <Switch
                      checked={m.enabled}
                      onCheckedChange={(v) => onToggleModel(m.model_id, m.mode, v)}
                    />
                    {m.source === 'manual' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => onDeleteModel(m.model_id, m.mode)}
                        title={t('admin:provider.deleteModel.tooltip')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-600" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {models.length > 0 && (
            <div className="pt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={onBackfillContextWindows}
                title={t('admin:provider.backfillContextWindows.tooltip')}
              >
                {t('admin:provider.backfillContextWindows.label')}
              </Button>
            </div>
          )}
          {/* Default subagent provider/model + per-profile overrides */}
          <div className="pt-3 mt-3 border-t space-y-3">
            <SubagentTargetSelect
              parentProviderId={p.id}
              providerId={selectedSubagentProviderId}
              modelId={selectedSubagentModelId}
              providerOptions={enabledSubagentProviderOptions}
              allProviders={allProviders}
              baseModels={models}
              providerModelsById={providerModelsById}
              onLoadProviderModels={onLoadProviderModels}
              onChange={(providerId, modelId) => onSetSubagentTarget(p.id, providerId, modelId)}
              effort={readSubagentModelId(p.extra?.subagent_effort)}
              onEffortChange={(effort) => onSetSubagentEffort(p.id, effort)}
              providerLabel={t('admin:provider.subagentProvider')}
              modelLabel={t('admin:provider.subagentModel')}
              effortLabel={t('admin:provider.subagentEffort')}
              providerEmptyLabel={t('admin:provider.subagentProviderDefault')}
              modelEmptyLabel={t('admin:provider.subagentModelDefault')}
              effortEmptyLabel={t('admin:provider.subagentEffortDefault')}
              providerAriaLabel="Default subagent provider"
              modelAriaLabel="Default subagent model"
              effortAriaLabel="Default subagent effort"
            />
            <SubagentProfilesPanel
              provider={p}
              allProviders={allProviders}
              models={models}
              providerModelsById={providerModelsById}
              onLoadProviderModels={onLoadProviderModels}
              onSetProfileTarget={(providerId, profileId, subProviderId, modelId) =>
                onSetSubagentTarget(providerId, subProviderId, modelId, profileId)
              }
              onSetProfileEffort={(providerId, profileId, effort) =>
                onSetSubagentEffort(providerId, effort, profileId)
              }
              onSetProfileLimits={(providerId, profileId, patch) =>
                onSetSubagentLimits(providerId, profileId, patch)
              }
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function readSubagentProviderId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSubagentModelId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Inline numeric-override editor for a single model row (context window,
 * tool cap, ...). Shows a read-only pill by default; clicking flips it into
 * a numeric input. Empty input clears the override (sends null → DB null →
 * registry fallback wins).
 *
 * Lazy state so we don't blow re-renders for every model row when nothing
 * is being edited.
 */
function NumericOverrideField({
  modelId,
  mode,
  value,
  onSet,
  min,
  placeholder,
  unknownLabel,
  format,
  titleUnknown,
  titleValue,
  warnWhenNull = false,
}: {
  modelId: string;
  mode: string;
  value: number | null;
  onSet: (modelId: string, mode: string, value: number | null) => void;
  min: number;
  placeholder: string;
  unknownLabel: string;
  format: (v: number) => string;
  titleUnknown: string;
  titleValue: (v: number) => string;
  /** Amber-tint the null pill (e.g. unknown context window = a problem). */
  warnWhenNull?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  if (!editing) {
    return (
      <button
        type="button"
        className={
          'h-7 px-2 rounded border text-[11px] font-mono ' +
          (value == null && warnWhenNull
            ? 'border-amber-500/40 text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground hover:bg-muted')
        }
        title={value == null ? titleUnknown : titleValue(value)}
        onClick={() => {
          setDraft(value != null ? String(value) : '');
          setEditing(true);
        }}
      >
        {value == null ? unknownLabel : format(value)}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') {
      onSet(modelId, mode, null);
      return;
    }
    const n = Number(trimmed.replace(/[_,]/g, ''));
    if (!isFinite(n) || n < min) return; // server validates too
    onSet(modelId, mode, n);
  };
  return (
    <input
      type="text"
      autoFocus
      className="h-7 w-24 rounded border bg-background px-1.5 text-xs font-mono"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(value != null ? String(value) : '');
          setEditing(false);
        }
      }}
    />
  );
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1e6).toFixed(2))}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}


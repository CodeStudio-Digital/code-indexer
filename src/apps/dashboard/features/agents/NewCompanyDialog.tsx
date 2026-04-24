import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { useApi, apiPost } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';

interface Template {
  id: number;
  name: string;
  description: string;
  roles: Array<{ role: string; provider: string; model: string; tier: string; skills?: string[] }>;
}

interface Project {
  id: number;
  name: string;
  root_path: string;
}

interface NewCompanyDialogProps {
  onClose: () => void;
  onCreated: (sessionId: number) => void;
}

/**
 * Translate the UI preset into the `builder.limits` payload the server
 * expects (or `null` to mean "use server-side defaults").
 *   - default  → null (respects MCP_SANDBOX_* env)
 *   - small    → 512m / 0.5 CPU / 128 pids
 *   - medium   → 1g   / 1   CPU / 256 pids  (matches factory default)
 *   - large    → 2g   / 2   CPU / 512 pids
 *   - custom   → whatever the three text fields hold
 */
function resolveLimitsFromForm(
  preset: 'default' | 'small' | 'medium' | 'large' | 'custom',
  memory: string,
  cpus: string,
  pids: string,
): { memory: string; cpus: string; pids: number } | null {
  if (preset === 'default') return null;
  if (preset === 'small') return { memory: '512m', cpus: '0.5', pids: 128 };
  if (preset === 'medium') return { memory: '1g', cpus: '1', pids: 256 };
  if (preset === 'large') return { memory: '2g', cpus: '2', pids: 512 };
  // custom — trim and validate only the bits that were actually touched.
  const pidsNum = Number(pids);
  return {
    memory: memory.trim() || '1g',
    cpus: cpus.trim() || '1',
    pids: Number.isFinite(pidsNum) && pidsNum >= 16 ? pidsNum : 256,
  };
}

export function NewCompanyDialog({ onClose, onCreated }: NewCompanyDialogProps) {
  const { t } = useTranslation(['agents', 'common']);
  const { data: templates, loading: templatesLoading } = useApi<Template[]>('/company/templates');
  const { data: projects } = useApi<Project[]>('/projects');
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();

  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [selectedProjectIds, setSelectedProjectIds] = useState<number[]>([]);
  const [masterProvider, setMasterProvider] = useState(providerOptions[0]?.id ?? 'anthropic');
  const [masterModel, setMasterModel] = useState('claude-sonnet-4-6');
  const [masterFallbackProvider, setMasterFallbackProvider] = useState<string | null>(null);
  const [masterFallbackModel, setMasterFallbackModel] = useState<string | null>(null);
  // Builder mode: when the user picks a stack, the backend provisions a
  // sandbox and enables the live-preview pane. 'off' preserves the
  // traditional company-session flow (no sandbox, no preview).
  const [builderStack, setBuilderStack] = useState<'off' | 'react-ts' | 'vue-ts' | 'angular' | 'vite-api' | 'cf-worker'>('off');
  // Per-session CPU/memory preset. `default` uses server env defaults
  // (1g/1cpu unless MCP_SANDBOX_* is set). `custom` reveals three
  // inputs for operators who need something specific.
  const [limitsPreset, setLimitsPreset] = useState<
    'default' | 'small' | 'medium' | 'large' | 'custom'
  >('default');
  const [customMemory, setCustomMemory] = useState('1g');
  const [customCpus, setCustomCpus] = useState('1');
  const [customPids, setCustomPids] = useState('256');
  /**
   * Curated pool of (provider, model) tuples the master can spawn
   * subordinates with. Empty list = no restriction (backward compat).
   * Non-empty list = server-side enforcement; master gets an error if
   * it picks outside.
   */
  interface PoolEntry {
    provider: string;
    model: string;
    label?: string;
    notes?: string;
    is_default?: boolean;
  }
  const [allowedModels, setAllowedModels] = useState<PoolEntry[]>([]);
  // Staging state for the "Add model" row so we can validate before
  // committing to the list.
  const [newPoolProvider, setNewPoolProvider] = useState<string>('');
  const [newPoolModel, setNewPoolModel] = useState<string>('');
  const [newPoolNotes, setNewPoolNotes] = useState<string>('');
  const [creating, setCreating] = useState(false);

  const selectedTemplate = templates?.find((t) => t.id === selectedTemplateId);
  const masterModels = getModelsForProvider(masterProvider);
  // When a template is selected, its master-role provider/model are the
  // source of truth — the manual picker below is disabled and synced to
  // keep the payload coherent. Previously the dialog saved
  // master_provider/model from the free-form inputs while also sending
  // template_id, producing mismatched sessions where subordinates
  // followed the template but the master ran on an unrelated model.
  const templateMaster = selectedTemplate?.roles.find((r) => r.role === 'master') ?? null;

  function toggleProject(id: number) {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function handleMasterProviderChange(newProvider: string) {
    setMasterProvider(newProvider);
    setMasterModel(getDefaultModel(newProvider));
  }

  // Sync master provider/model to the template's master role whenever
  // the selected template changes. Users can still override the master
  // manually AFTER selecting a template by unchecking it, but the default
  // is: template wins.
  useEffect(() => {
    if (templateMaster) {
      setMasterProvider(templateMaster.provider);
      setMasterModel(templateMaster.model);
    }
  }, [templateMaster?.provider, templateMaster?.model]);

  const builderEnabled = builderStack !== 'off';
  // Builder mode creates its own sandbox-backed project automatically,
  // so picking host projects is optional (advanced use: reference an
  // existing codebase while scaffolding a new one). Traditional mode
  // still requires at least one linked project.
  const projectsRequired = !builderEnabled;

  async function handleCreate() {
    if (!name.trim()) return;
    if (projectsRequired && selectedProjectIds.length === 0) return;

    setCreating(true);
    try {
      const res = await apiPost<{ session: { id: number } }>('/company/sessions', {
        template_id: selectedTemplateId,
        name: name.trim(),
        project_ids: selectedProjectIds,
        master_provider: masterProvider,
        master_model: masterModel,
        master_fallback_provider: masterFallbackProvider,
        master_fallback_model: masterFallbackModel,
        role_assignments: selectedTemplate?.roles.filter((r) => r.role !== 'master') ?? [],
        // Submit the allowed-models pool only when non-empty; an empty
        // list would read as "strict empty pool" on the server and
        // would reject every spawn. Empty == "no restriction", matching
        // the legacy behavior.
        ...(allowedModels.length > 0 ? { allowed_models: allowedModels } : {}),
        // Only send `builder` when the user picked a real stack. Leaving
        // the field absent keeps the payload identical to the legacy
        // format, so nothing about non-builder sessions changes server-side.
        ...(builderStack !== 'off'
          ? {
              builder: {
                stack: builderStack,
                ...(resolveLimitsFromForm(limitsPreset, customMemory, customCpus, customPids)
                  ? {
                      limits: resolveLimitsFromForm(
                        limitsPreset,
                        customMemory,
                        customCpus,
                        customPids,
                      )!,
                    }
                  : {}),
              },
            }
          : {}),
      });
      onCreated(res.session.id);
      onClose();
    } catch (e) {
      console.error('Failed to create company session:', e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card rounded-lg border shadow-lg w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <div className="px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{t('agents:newCompanyDialog.title')}</h2>
        </div>

        <div className="p-6 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('agents:newCompanyDialog.sessionName')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
              placeholder={t('agents:newCompanyDialog.sessionPlaceholder')}
            />
          </div>

          {/* Template */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">{t('agents:newCompanyDialog.template')}</label>
            <select
              value={selectedTemplateId ?? ''}
              onChange={(e) => setSelectedTemplateId(e.target.value ? Number(e.target.value) : null)}
              disabled={templatesLoading}
              className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">{templatesLoading ? 'Loading templates…' : t('agents:newCompanyDialog.customTemplate')}</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>{t.name} — {t.description}</option>
              ))}
            </select>
            {selectedTemplate ? (
              <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs space-y-1">
                <div className="font-medium text-primary">✓ Template locked: {selectedTemplate.name}</div>
                {selectedTemplate.roles.map((r) => (
                  <div key={r.role} className="font-mono text-[11px] text-muted-foreground">
                    <span className="text-foreground">{r.role}</span>
                    {' → '}
                    {r.provider}/{r.model}
                    {r.tier ? ` · tier=${r.tier}` : ''}
                    {r.skills?.length ? ` · skills=${r.skills.length}` : ''}
                  </div>
                ))}
                <div className="mt-1 text-[10px] italic text-muted-foreground">
                  Master provider/model and every role's model are enforced by this template.
                </div>
              </div>
            ) : templatesLoading ? (
              <div className="mt-2 text-xs text-amber-600 italic">
                Templates still loading — wait before clicking Create to avoid saving as "Custom".
              </div>
            ) : (
              <div className="mt-2 text-xs text-amber-600 italic">
                No template selected — subordinates will inherit the master's provider/model as a fallback.
              </div>
            )}
          </div>

          {/* Projects */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t('agents:newCompanyDialog.projects', { count: selectedProjectIds.length })}
              {!projectsRequired && (
                <span className="ml-1 text-[10px] font-normal italic opacity-70">
                  (optional — builder creates its own)
                </span>
              )}
            </label>
            <div className="mt-1 max-h-40 overflow-y-auto border rounded-md divide-y">
              {projects?.map((p) => (
                <label key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={selectedProjectIds.includes(p.id)}
                    onChange={() => toggleProject(p.id)}
                    className="rounded border-gray-300"
                  />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground truncate ml-auto text-[10px]">{p.root_path}</span>
                </label>
              ))}
              {(!projects || projects.length === 0) && (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t('agents:newCompanyDialog.noProjects')}</p>
              )}
            </div>
          </div>

          {/* Master provider/model — from admin config. Disabled when a
              template is selected since the template's master role is
              the source of truth. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {t('agents:newCompanyDialog.masterProvider')}
                {templateMaster && <span className="ml-1 text-[10px] text-primary">(from template)</span>}
              </label>
              <select
                value={masterProvider}
                onChange={(e) => handleMasterProviderChange(e.target.value)}
                disabled={!!templateMaster}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {t('agents:newCompanyDialog.masterModel')}
                {templateMaster && <span className="ml-1 text-[10px] text-primary">(from template)</span>}
              </label>
              {masterModels.length > 0 ? (
                <select
                  value={masterModel}
                  onChange={(e) => setMasterModel(e.target.value)}
                  disabled={!!templateMaster}
                  className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {masterModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.mode ? ` (${m.mode})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={masterModel}
                  onChange={(e) => setMasterModel(e.target.value)}
                  disabled={!!templateMaster}
                  className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono disabled:opacity-60 disabled:cursor-not-allowed"
                  placeholder={t('agents:newCompanyDialog.modelPlaceholder')}
                />
              )}
            </div>
          </div>

          {/* Builder mode (optional) — v0-style live preview.
              When a stack is selected, the orchestrator spins up an
              ephemeral sandbox and the session opens in the split-pane
              builder view instead of the traditional board layout. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Builder mode (live preview)
            </label>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:flex">
              {([
                { v: 'off', label: 'Off (traditional)' },
                { v: 'react-ts', label: 'React + Vite' },
                { v: 'vue-ts', label: 'Vue 3 + Vite' },
                { v: 'angular', label: 'Angular 19' },
                { v: 'vite-api', label: 'API — Hono + Vite' },
                { v: 'cf-worker', label: 'API — Cloudflare Worker' },
              ] as const).map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setBuilderStack(opt.v)}
                  className={
                    'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ' +
                    (builderStack === opt.v
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background hover:bg-muted')
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {builderStack !== 'off' && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                A sandbox container will be provisioned on session start. HMR-enabled
                preview appears in a side pane.
              </p>
            )}
          </div>

          {/* Container limits — only relevant when builder is on. */}
          {builderStack !== 'off' && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Container resources
              </label>
              <div className="mt-1 grid grid-cols-5 gap-1.5">
                {([
                  { v: 'default', label: 'Default', hint: 'Server-configured' },
                  { v: 'small', label: 'Small', hint: '512m · 0.5 CPU' },
                  { v: 'medium', label: 'Medium', hint: '1g · 1 CPU' },
                  { v: 'large', label: 'Large', hint: '2g · 2 CPUs' },
                  { v: 'custom', label: 'Custom', hint: 'Fine-tune' },
                ] as const).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setLimitsPreset(opt.v)}
                    className={
                      'rounded-md border px-2 py-1.5 text-[11px] leading-tight transition-colors flex flex-col ' +
                      (limitsPreset === opt.v
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background hover:bg-muted')
                    }
                    title={opt.hint}
                  >
                    <span className="font-medium">{opt.label}</span>
                    <span className="opacity-70 text-[9px]">{opt.hint}</span>
                  </button>
                ))}
              </div>
              {limitsPreset === 'custom' && (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-muted-foreground">
                      Memory
                    </label>
                    <input
                      value={customMemory}
                      onChange={(e) => setCustomMemory(e.target.value)}
                      placeholder="1g"
                      className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground">CPUs</label>
                    <input
                      value={customCpus}
                      onChange={(e) => setCustomCpus(e.target.value)}
                      placeholder="1"
                      className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground">PIDs</label>
                    <input
                      value={customPids}
                      onChange={(e) => setCustomPids(e.target.value)}
                      placeholder="256"
                      inputMode="numeric"
                      className="w-full mt-0.5 rounded-md border bg-background px-2 py-1 text-xs font-mono"
                    />
                  </div>
                </div>
              )}
              <p className="mt-1 text-[10px] text-muted-foreground">
                Memory accepts suffixes like <code className="font-mono">512m</code>,
                {' '}<code className="font-mono">1g</code>. CPUs is fractional
                (<code className="font-mono">0.5</code>, <code className="font-mono">2</code>).
              </p>
            </div>
          )}

          {/* Master fallback provider+model */}
          <FallbackPicker
            fallbackProvider={masterFallbackProvider}
            fallbackModel={masterFallbackModel}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            onChange={(p, m) => { setMasterFallbackProvider(p); setMasterFallbackModel(m); }}
          />

          {/* Allowed subordinate models (optional pool). When left empty,
              the master retains unconstrained freedom like before. When
              populated, server-side enforcement rejects any spawn whose
              (provider, model) is not listed here. */}
          <div>
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-2">
              Allowed subordinate models
              <span className="text-[10px] font-normal italic opacity-70">
                (optional — empty = no restriction)
              </span>
            </label>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Constrain which models the master can pick when spawning sub-agents. Prevents
              hallucinated model names; the master sees this list in its prompt and picks from it.
              The first entry (or the one marked default) is used when no explicit model is given.
            </p>

            {allowedModels.length > 0 && (
              <div className="mt-2 border rounded-md divide-y">
                {allowedModels.map((entry, i) => (
                  <div key={`${entry.provider}/${entry.model}`} className="px-3 py-2 text-xs flex items-center gap-2">
                    <input
                      type="radio"
                      name="pool-default"
                      checked={!!entry.is_default}
                      onChange={() => {
                        setAllowedModels((prev) =>
                          prev.map((e, idx) => ({ ...e, is_default: idx === i })),
                        );
                      }}
                      title="Mark as default (used when master spawns without explicit model)"
                    />
                    <span className="font-mono">{entry.provider}/{entry.model}</span>
                    {entry.is_default && (
                      <span className="text-[10px] text-primary font-medium">default</span>
                    )}
                    {entry.notes && (
                      <span className="text-muted-foreground truncate italic">— {entry.notes}</span>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setAllowedModels((prev) => {
                          const next = prev.filter((_, idx) => idx !== i);
                          // If we just removed the default, promote the
                          // first remaining entry so `is_default` is always
                          // self-consistent.
                          if (entry.is_default && next.length > 0) next[0].is_default = true;
                          return next;
                        })
                      }
                      className="ml-auto text-destructive hover:underline text-[11px]"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add-model row */}
            <div className="mt-2 grid grid-cols-[1fr_1fr_1.2fr_auto] gap-1.5">
              <select
                value={newPoolProvider}
                onChange={(e) => {
                  setNewPoolProvider(e.target.value);
                  // Auto-suggest the default model for the chosen provider
                  // so the user doesn't have to hunt for it.
                  const def = getDefaultModel(e.target.value);
                  if (def) setNewPoolModel(def);
                }}
                className="rounded-md border bg-background px-2 py-1 text-xs"
              >
                <option value="">Provider…</option>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {newPoolProvider && getModelsForProvider(newPoolProvider).length > 0 ? (
                <select
                  value={newPoolModel}
                  onChange={(e) => setNewPoolModel(e.target.value)}
                  className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
                >
                  <option value="">Model…</option>
                  {getModelsForProvider(newPoolProvider).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={newPoolModel}
                  onChange={(e) => setNewPoolModel(e.target.value)}
                  placeholder="model name"
                  className="rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
              )}
              <input
                value={newPoolNotes}
                onChange={(e) => setNewPoolNotes(e.target.value)}
                placeholder="notes (e.g. cheap — trivial tasks)"
                className="rounded-md border bg-background px-2 py-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!newPoolProvider.trim() || !newPoolModel.trim()}
                onClick={() => {
                  const provider = newPoolProvider.trim();
                  const model = newPoolModel.trim();
                  if (!provider || !model) return;
                  // Silently dedupe — a common mistake is adding the
                  // master model twice when it was already auto-included.
                  if (allowedModels.some((e) => e.provider === provider && e.model === model)) {
                    setNewPoolNotes('');
                    return;
                  }
                  setAllowedModels((prev) => [
                    ...prev,
                    {
                      provider,
                      model,
                      notes: newPoolNotes.trim() || undefined,
                      is_default: prev.length === 0, // first entry is default
                    },
                  ]);
                  setNewPoolNotes('');
                }}
              >
                + Add
              </Button>
            </div>

            {/* Convenience: pre-populate with the master model in one click. */}
            {allowedModels.length === 0 && (
              <button
                type="button"
                onClick={() =>
                  setAllowedModels([
                    {
                      provider: masterProvider,
                      model: masterModel,
                      notes: 'master model',
                      is_default: true,
                    },
                  ])
                }
                className="mt-2 text-[11px] text-primary hover:underline"
              >
                Use master model as the only allowed entry
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">{t('common:actions.cancel')}</Button>
          <Button
            onClick={handleCreate}
            disabled={
              creating ||
              !name.trim() ||
              (projectsRequired && selectedProjectIds.length === 0)
            }
            size="sm"
          >
            {creating ? t('agents:newCompanyDialog.creating') : t('agents:newCompanyDialog.createStart')}
          </Button>
        </div>
      </div>
    </div>
  );
}

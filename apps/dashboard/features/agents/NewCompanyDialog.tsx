import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { useApi, apiPost } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';
import { FallbackPicker } from '../../components/FallbackPicker.js';
import { AllowedModelsEditor } from './new-company-dialog/AllowedModelsEditor.js';
import { BuilderModeSection } from './new-company-dialog/BuilderModeSection.js';
import {
  resolveLimitsFromForm,
  type BuilderStack,
  type LimitsPreset,
  type PoolEntry,
  type Project,
  type ProjectManifestResponse,
  type Template,
} from './new-company-dialog/types.js';

interface NewCompanyDialogProps {
  onClose: () => void;
  onCreated: (sessionId: number) => void;
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
  const [builderStack, setBuilderStack] = useState<BuilderStack>('off');
  const [mainProjectId, setMainProjectId] = useState<number | null>(null);
  const [mainProjectRuntime, setMainProjectRuntime] = useState<'node' | 'dockerfile'>('node');
  const [mainProjectManifest, setMainProjectManifest] = useState<ProjectManifestResponse | null>(null);
  const [mainProjectManifestLoading, setMainProjectManifestLoading] = useState(false);
  // Per-session CPU/memory preset. `default` uses server env defaults
  // (1g/1cpu unless MCP_SANDBOX_* is set). `custom` reveals three
  // inputs for operators who need something specific.
  const [limitsPreset, setLimitsPreset] = useState<LimitsPreset>('default');
  const [customMemory, setCustomMemory] = useState('1g');
  const [customCpus, setCustomCpus] = useState('1');
  const [customPids, setCustomPids] = useState('256');
  // Curated pool of (provider, model) tuples the master can spawn
  // subordinates with. Empty list = no restriction (backward compat).
  // Non-empty list = server-side enforcement; master gets an error if
  // it picks outside. The editor that owns the per-row state lives in
  // `new-company-dialog/AllowedModelsEditor.tsx`.
  const [allowedModels, setAllowedModels] = useState<PoolEntry[]>([]);
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
  const needsExternalMainProject = builderEnabled && selectedProjectIds.length > 0;
  const mainProjectNodeOk =
    !needsExternalMainProject ||
    (mainProjectManifest?.manifest?.kind === 'node' &&
      !!mainProjectManifest.manifest.devScriptName);
  const mainProjectDockerfileOk =
    !needsExternalMainProject || !!mainProjectManifest?.dockerfile?.exposedPorts?.[0];
  const mainProjectRuntimeOk =
    mainProjectRuntime === 'node' ? mainProjectNodeOk : mainProjectDockerfileOk;

  useEffect(() => {
    if (!needsExternalMainProject) {
      setMainProjectId(null);
      return;
    }
    if (!mainProjectId || !selectedProjectIds.includes(mainProjectId)) {
      setMainProjectId(selectedProjectIds[0] ?? null);
    }
  }, [needsExternalMainProject, selectedProjectIds, mainProjectId]);

  useEffect(() => {
    if (!needsExternalMainProject || !mainProjectId) {
      setMainProjectManifest(null);
      return;
    }
    let cancelled = false;
    setMainProjectManifestLoading(true);
    fetch(`/api/projects/${mainProjectId}/manifest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: ProjectManifestResponse | null) => {
        if (!cancelled) {
          setMainProjectManifest(body);
          if (body?.manifest?.kind === 'node' && body.manifest.devScriptName) {
            setMainProjectRuntime('node');
          } else if (body?.dockerfile?.exposedPorts?.[0]) {
            setMainProjectRuntime('dockerfile');
          }
        }
      })
      .catch(() => {
        if (!cancelled) setMainProjectManifest(null);
      })
      .finally(() => {
        if (!cancelled) setMainProjectManifestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsExternalMainProject, mainProjectId]);

  async function handleCreate() {
    if (!name.trim()) return;
    if (projectsRequired && selectedProjectIds.length === 0) return;
    if (needsExternalMainProject && (!mainProjectId || !mainProjectRuntimeOk)) return;

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
                ...(mainProjectId ? { main_project_id: mainProjectId } : {}),
                ...(mainProjectId ? { main_project_runtime: mainProjectRuntime } : {}),
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

          {needsExternalMainProject && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <label className="text-xs font-medium text-muted-foreground">
                {t('agents:mainProject.label')}
              </label>
              <select
                value={mainProjectId ?? ''}
                onChange={(e) => setMainProjectId(e.target.value ? Number(e.target.value) : null)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                {selectedProjectIds.map((id) => {
                  const project = projects?.find((p) => p.id === id);
                  return (
                    <option key={id} value={id}>
                      {project?.name ?? `project-${id}`} — {project?.root_path ?? ''}
                    </option>
                  );
                })}
              </select>
              <div className="mt-2 grid grid-cols-2 gap-1">
                <button
                  type="button"
                  className={
                    'rounded border px-2 py-1 text-[10px] ' +
                    (mainProjectRuntime === 'node'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background hover:bg-accent')
                  }
                  onClick={() => setMainProjectRuntime('node')}
                >
                  {t('agents:mainProject.nodeRuntime')}
                </button>
                <button
                  type="button"
                  className={
                    'rounded border px-2 py-1 text-[10px] ' +
                    (mainProjectRuntime === 'dockerfile'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background hover:bg-accent')
                  }
                  onClick={() => setMainProjectRuntime('dockerfile')}
                >
                  {t('agents:mainProject.dockerfileRuntime')}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                  {t('agents:mainProject.preserved')}
                </span>
                {mainProjectManifestLoading && (
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    {t('agents:mainProject.checking')}
                  </span>
                )}
                {mainProjectManifest?.manifest && (
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    {mainProjectManifest.manifest.kind}
                    {mainProjectManifest.manifest.packageManager
                      ? ` (${mainProjectManifest.manifest.packageManager})`
                      : ''}
                    {mainProjectManifest.manifest.devScriptName
                      ? ` · ${mainProjectManifest.manifest.devScriptName}`
                      : ''}
                  </span>
                )}
                {mainProjectRuntime === 'node' && !mainProjectNodeOk && !mainProjectManifestLoading && (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-600">
                    {t('agents:mainProject.nodeRuntimeRequired')}
                  </span>
                )}
                {mainProjectManifest?.dockerfile?.exposedPorts?.[0] ? (
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600">
                    {t('agents:mainProject.dockerfileDetected', {
                      port: mainProjectManifest.dockerfile.exposedPorts[0],
                    })}
                  </span>
                ) : mainProjectRuntime === 'dockerfile' && !mainProjectManifestLoading ? (
                  <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-600">
                    {t('agents:mainProject.dockerfileRequired')}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                {t('agents:mainProject.helper')}
              </p>
            </div>
          )}

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

          {/* Builder mode + container resources. */}
          <BuilderModeSection
            builderStack={builderStack}
            setBuilderStack={setBuilderStack}
            limitsPreset={limitsPreset}
            setLimitsPreset={setLimitsPreset}
            customMemory={customMemory}
            setCustomMemory={setCustomMemory}
            customCpus={customCpus}
            setCustomCpus={setCustomCpus}
            customPids={customPids}
            setCustomPids={setCustomPids}
          />

          {/* Master fallback provider+model */}
          <FallbackPicker
            fallbackProvider={masterFallbackProvider}
            fallbackModel={masterFallbackModel}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            onChange={(p, m) => { setMasterFallbackProvider(p); setMasterFallbackModel(m); }}
          />

          <AllowedModelsEditor
            allowedModels={allowedModels}
            setAllowedModels={setAllowedModels}
            masterProvider={masterProvider}
            masterModel={masterModel}
            providerOptions={providerOptions}
            getModelsForProvider={getModelsForProvider}
            getDefaultModel={getDefaultModel}
          />
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">{t('common:actions.cancel')}</Button>
          <Button
            onClick={handleCreate}
            disabled={
              creating ||
              !name.trim() ||
              (projectsRequired && selectedProjectIds.length === 0) ||
              (needsExternalMainProject && (!mainProjectId || !mainProjectRuntimeOk))
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

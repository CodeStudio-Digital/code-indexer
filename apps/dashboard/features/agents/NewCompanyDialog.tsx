import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, Crown, FolderKanban, LayoutTemplate, Search, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { useApi, apiPost } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';
import { type Project, type Template } from './new-company-dialog/types.js';

interface NewCompanyDialogProps {
  onClose: () => void;
  onCreated: (sessionId: number) => void;
}

/**
 * Creation wizard, intentionally minimal: name + projects + master model.
 * Everything else (template) lives behind the collapsed "Advanced"
 * section; post-create config (roles, fallback, operational rules,
 * services) belongs to the session sidebar. The rarely-used
 * `allowed_models` pool and `master_broadcast_subscribe` flag are API-only
 * now — the server still accepts and enforces both.
 */
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
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(0);
  const [projectQuery, setProjectQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const selectedTemplate = templates?.find((t) => t.id === selectedTemplateId);
  const masterModels = getModelsForProvider(masterProvider);
  // When a template is selected, its master-role provider/model are the
  // source of truth — the manual picker below is disabled and synced to
  // keep the payload coherent. Previously the dialog saved
  // master_provider/model from the free-form inputs while also sending
  // template_id, producing mismatched sessions where subordinates
  // followed the template but the master ran on an unrelated model.
  const templateMaster = selectedTemplate?.roles.find((r) => r.role === 'master') ?? null;
  const filteredProjects = (projects ?? []).filter((project) => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${project.name} ${project.root_path}`.toLocaleLowerCase().includes(query);
  });

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

  async function handleCreate() {
    if (!name.trim()) return;
    if (selectedProjectIds.length === 0) return;

    setCreating(true);
    setError(null);
    try {
      const res = await apiPost<{ session: { id: number } }>('/company/sessions', {
        template_id: selectedTemplateId,
        name: name.trim(),
        project_ids: selectedProjectIds,
        master_provider: masterProvider,
        master_model: masterModel,
        role_assignments: selectedTemplate?.roles.filter((r) => r.role !== 'master') ?? [],
      });
      onCreated(res.session.id);
      onClose();
    } catch (e) {
      console.error('Failed to create company session:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-4xl flex-col gap-0 overflow-hidden border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-0">
        <DialogHeader className="border-b border-[var(--workbench-border)] px-5 py-4 text-left">
          <DialogTitle>{t('agents:newCompanyDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('agents:newCompanyDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-5">
          {[
            ['1', t('agents:newCompanyDialog.steps.identity'), LayoutTemplate],
            ['2', t('agents:newCompanyDialog.steps.projects'), FolderKanban],
            ['3', t('agents:newCompanyDialog.steps.orchestration'), Sparkles],
          ].map(([number, label, Icon], index) => (
            <button
              type="button"
              key={String(label)}
              onClick={() => {
                if (index === 0 || (index === 1 && name.trim()) || (index === 2 && name.trim() && selectedProjectIds.length > 0)) {
                  setStep(index);
                }
              }}
              className={`relative flex h-11 items-center justify-center gap-2 text-[11px] transition-colors ${
                step === index ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className={`grid h-5 w-5 place-items-center rounded-full border text-[9px] ${
                step > index
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : step === index
                    ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                    : 'border-[var(--workbench-border)]'
              }`}>
                {step > index ? <Check className="h-3 w-3" /> : String(number)}
              </span>
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{String(label)}</span>
              {step === index && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded bg-violet-500" />}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {step === 0 && (
            <div className="mx-auto max-w-3xl space-y-5">
              <div>
                <label className="text-[11px] font-medium text-foreground">{t('agents:newCompanyDialog.sessionName')}</label>
                <p className="mb-2 text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.sessionNameHint')}</p>
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-3 text-sm outline-none transition-colors focus:border-[var(--workbench-focus)]"
                  placeholder={t('agents:newCompanyDialog.sessionPlaceholder')}
                />
              </div>

              <div>
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <label className="text-[11px] font-medium text-foreground">{t('agents:newCompanyDialog.template')}</label>
                    <p className="text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.templateHint')}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.availableTemplates', { count: templates?.length ?? 0 })}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSelectedTemplateId(null)}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      selectedTemplateId == null
                        ? 'border-violet-500/60 bg-violet-500/8'
                        : 'border-[var(--workbench-border)] hover:bg-[var(--workbench-hover)]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="grid h-7 w-7 place-items-center rounded bg-[var(--workbench-raised)]"><Sparkles className="h-3.5 w-3.5" /></span>
                      <span className="text-[11px] font-medium">{t('agents:newCompanyDialog.customConfiguration')}</span>
                      {selectedTemplateId == null && <Check className="ml-auto h-3.5 w-3.5 text-violet-400" />}
                    </div>
                    <p className="mt-2 text-[10px] leading-4 text-muted-foreground">{t('agents:newCompanyDialog.customConfigurationHint')}</p>
                  </button>
                  {templatesLoading ? (
                    <div className="rounded-md border border-[var(--workbench-border)] p-3 text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.loadingTemplates')}</div>
                  ) : templates?.map((template) => (
                    <button
                      type="button"
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        selectedTemplateId === template.id
                          ? 'border-violet-500/60 bg-violet-500/8'
                          : 'border-[var(--workbench-border)] hover:bg-[var(--workbench-hover)]'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="grid h-7 w-7 place-items-center rounded bg-[var(--workbench-raised)]"><LayoutTemplate className="h-3.5 w-3.5" /></span>
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{template.name}</span>
                        {selectedTemplateId === template.id && <Check className="h-3.5 w-3.5 text-violet-400" />}
                      </div>
                      <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{template.description || t('agents:newCompanyDialog.defaultTemplateDescription')}</p>
                      <span className="mt-2 block text-[9px] text-muted-foreground">{t('agents:newCompanyDialog.configuredRoles', { count: template.roles.length })}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="mx-auto flex h-full max-w-3xl flex-col">
              <div className="mb-3">
                <h3 className="text-sm font-semibold">{t('agents:newCompanyDialog.selectProjects')}</h3>
                <p className="text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.selectProjectsHint')}</p>
              </div>
              <label className="mb-2 flex h-8 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-muted-foreground focus-within:border-[var(--workbench-focus)]">
                <Search className="h-3.5 w-3.5" />
                <input
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder={t('agents:newCompanyDialog.projectSearchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none"
                />
                <span className="text-[9px] tabular-nums">{t('agents:newCompanyDialog.selectedProjects', { count: selectedProjectIds.length })}</span>
              </label>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-md border border-[var(--workbench-border)] p-1.5">
                {filteredProjects.map((project) => {
                  const checked = selectedProjectIds.includes(project.id);
                  return (
                    <label
                      key={project.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-2.5 py-2 transition-colors ${
                        checked ? 'border-violet-500/40 bg-violet-500/8' : 'border-transparent hover:bg-[var(--workbench-hover)]'
                      }`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleProject(project.id)} className="rounded" />
                      <span className="grid h-7 w-7 place-items-center rounded bg-[var(--workbench-raised)] text-muted-foreground">
                        <FolderKanban className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-foreground">{project.name}</span>
                        <span className="block truncate font-mono text-[9px] text-muted-foreground">{project.root_path}</span>
                      </span>
                    </label>
                  );
                })}
                {filteredProjects.length === 0 && (
                  <div className="px-4 py-10 text-center text-[11px] text-muted-foreground">{t('agents:newCompanyDialog.noProjects')}</div>
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">{t('agents:newCompanyDialog.masterAgent')}</h3>
                  <p className="text-[10px] text-muted-foreground">{t('agents:newCompanyDialog.masterAgentHint')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">{t('agents:newCompanyDialog.masterProvider')}</label>
                    <select
                      value={masterProvider}
                      onChange={(event) => handleMasterProviderChange(event.target.value)}
                      disabled={!!templateMaster}
                      className="mt-1 h-9 w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {providerOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">{t('agents:newCompanyDialog.masterModel')}</label>
                    {masterModels.length > 0 ? (
                      <select
                        value={masterModel}
                        onChange={(event) => setMasterModel(event.target.value)}
                        disabled={!!templateMaster}
                        className="mt-1 h-9 w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 font-mono text-[10px] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {masterModels.map((model) => <option key={model.id} value={model.id}>{model.name}{model.mode ? ` (${model.mode})` : ''}</option>)}
                      </select>
                    ) : (
                      <input
                        value={masterModel}
                        onChange={(event) => setMasterModel(event.target.value)}
                        disabled={!!templateMaster}
                        className="mt-1 h-9 w-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 font-mono text-[10px]"
                      />
                    )}
                  </div>
                </div>
                {templateMaster && (
                  <div className="flex gap-2 rounded-md border border-violet-500/30 bg-violet-500/8 p-3 text-[10px] text-muted-foreground">
                    <Crown className="h-4 w-4 shrink-0 text-amber-400" />
                    <span>{t('agents:newCompanyDialog.templateMasterHint')} <strong className="text-foreground">{selectedTemplate?.name}</strong>.</span>
                  </div>
                )}
                {selectedTemplate && (
                  <div className="rounded-md border border-[var(--workbench-border)]">
                    <div className="border-b border-[var(--workbench-border)] px-3 py-2 text-[10px] font-medium">{t('agents:newCompanyDialog.blueprintRoles')}</div>
                    <div className="divide-y divide-[var(--workbench-border)]">
                      {selectedTemplate.roles.map((role) => (
                        <div key={role.role} className="flex items-center gap-2 px-3 py-2 text-[10px]">
                          {role.role === 'master' ? <Crown className="h-3 w-3 text-amber-400" /> : <Sparkles className="h-3 w-3 text-muted-foreground" />}
                          <span className="font-medium text-foreground">{role.role}</span>
                          <span className="ml-auto truncate font-mono text-[9px] text-muted-foreground">{role.provider}/{role.model}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <aside className="rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-raised)] p-3">
                <h3 className="text-[11px] font-semibold">{t('agents:newCompanyDialog.companySummary')}</h3>
                <dl className="mt-3 space-y-3 text-[10px]">
                  <div><dt className="text-muted-foreground">{t('agents:newCompanyDialog.summary.name')}</dt><dd className="mt-0.5 font-medium text-foreground">{name}</dd></div>
                  <div><dt className="text-muted-foreground">{t('agents:newCompanyDialog.summary.projects')}</dt><dd className="mt-0.5 font-medium text-foreground">{t('agents:newCompanyDialog.selectedProjects', { count: selectedProjectIds.length })}</dd></div>
                  <div><dt className="text-muted-foreground">{t('agents:newCompanyDialog.summary.blueprint')}</dt><dd className="mt-0.5 font-medium text-foreground">{selectedTemplate?.name ?? t('agents:newCompanyDialog.custom')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('agents:newCompanyDialog.summary.master')}</dt><dd className="mt-0.5 break-all font-mono text-[9px] text-foreground">{masterProvider}/{masterModel}</dd></div>
                </dl>
              </aside>
            </div>
          )}

          {error && <div className="mx-auto mt-4 max-w-3xl rounded border border-destructive/30 bg-destructive/8 px-3 py-2 text-[10px] text-destructive">{error}</div>}
        </div>

        <DialogFooter className="flex-row items-center border-t border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-5 py-3 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common:actions.cancel')}</Button>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" className="gap-1" onClick={() => setStep((current) => current - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" /> {t('agents:newCompanyDialog.back')}
              </Button>
            )}
            {step < 2 ? (
              <Button
                size="sm"
                className="gap-1"
                disabled={step === 0 ? !name.trim() : selectedProjectIds.length === 0}
                onClick={() => setStep((current) => current + 1)}
              >
                {t('agents:newCompanyDialog.continue')} <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button onClick={handleCreate} disabled={creating || !name.trim() || selectedProjectIds.length === 0} size="sm">
                {creating ? t('agents:newCompanyDialog.creating') : t('agents:newCompanyDialog.createStart')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

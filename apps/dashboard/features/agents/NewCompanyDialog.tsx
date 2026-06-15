import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
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

  async function handleCreate() {
    if (!name.trim()) return;
    if (selectedProjectIds.length === 0) return;

    setCreating(true);
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

          {/* Projects */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {t('agents:newCompanyDialog.projects', { count: selectedProjectIds.length })}
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

          {/* Advanced — template. Collapsed by default; post-create knobs
              (roles, fallback, rules, services) live in the session
              sidebar, not here. */}
          <details className="rounded-md border">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/30">
              {t('agents:newCompanyDialog.advanced')}
            </summary>
            <div className="space-y-4 border-t p-3">
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
                ) : null}
              </div>
            </div>
          </details>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">{t('common:actions.cancel')}</Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim() || selectedProjectIds.length === 0}
            size="sm"
          >
            {creating ? t('agents:newCompanyDialog.creating') : t('agents:newCompanyDialog.createStart')}
          </Button>
        </div>
      </div>
    </div>
  );
}

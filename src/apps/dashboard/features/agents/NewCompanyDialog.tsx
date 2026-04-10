import React, { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { useApi, apiPost } from '../../hooks/useApi.js';
import { useProviders } from '../../hooks/useProviders.js';

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

export function NewCompanyDialog({ onClose, onCreated }: NewCompanyDialogProps) {
  const { data: templates } = useApi<Template[]>('/company/templates');
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

  function toggleProject(id: number) {
    setSelectedProjectIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function handleMasterProviderChange(newProvider: string) {
    setMasterProvider(newProvider);
    setMasterModel(getDefaultModel(newProvider));
  }

  async function handleCreate() {
    if (!name.trim() || selectedProjectIds.length === 0) return;

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
          <h2 className="text-lg font-semibold">Start Company Session</h2>
        </div>

        <div className="p-6 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Session Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
              placeholder="Feature Sprint Q2"
            />
          </div>

          {/* Template */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Template (optional)</label>
            <select
              value={selectedTemplateId ?? ''}
              onChange={(e) => setSelectedTemplateId(e.target.value ? Number(e.target.value) : null)}
              className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">Custom (no template)</option>
              {templates?.map((t) => (
                <option key={t.id} value={t.id}>{t.name} — {t.description}</option>
              ))}
            </select>
            {selectedTemplate && (
              <div className="mt-2 text-xs text-muted-foreground">
                Roles: {selectedTemplate.roles.map((r) => r.role).join(', ')}
              </div>
            )}
          </div>

          {/* Projects */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Projects ({selectedProjectIds.length} selected)
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
                <p className="px-3 py-2 text-xs text-muted-foreground">No indexed projects found.</p>
              )}
            </div>
          </div>

          {/* Master provider/model — from admin config */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Master Provider</label>
              <select
                value={masterProvider}
                onChange={(e) => handleMasterProviderChange(e.target.value)}
                className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Master Model</label>
              {masterModels.length > 0 ? (
                <select
                  value={masterModel}
                  onChange={(e) => setMasterModel(e.target.value)}
                  className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
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
                  className="w-full mt-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono"
                  placeholder="model name"
                />
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} size="sm">Cancel</Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !name.trim() || selectedProjectIds.length === 0}
            size="sm"
          >
            {creating ? 'Creating...' : 'Create & Start'}
          </Button>
        </div>
      </div>
    </div>
  );
}

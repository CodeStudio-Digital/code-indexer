/**
 * General project settings — name, root path, group, description. Text fields
 * with server-side validation (unique name, existing root), so this pane keeps
 * an explicit Save (delta PATCH) rather than save-on-keystroke. Extracted from
 * the old ProjectEditDialog.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@mcp/shared/types.js';
import { Button } from '../../../../components/ui/button.js';
import { Combobox } from '../../../../components/ui/combobox.js';
import { Input } from '../../../../components/ui/input.js';
import { Textarea } from '../../../../components/ui/textarea.js';
import { apiPatch } from '../../../../hooks/useApi.js';

interface GeneralPaneProps {
  project: Project;
  existingGroups?: string[];
  /** Receives ONLY the changed fields so the modal merges into its freshest project. */
  onSaved: (changed: Partial<Project>) => void;
}

export function GeneralPane({ project, existingGroups = [], onSaved }: GeneralPaneProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [name, setName] = useState(project.name);
  const [rootPath, setRootPath] = useState(project.root_path);
  const [description, setDescription] = useState(project.description ?? '');
  const [groupName, setGroupName] = useState(project.group_name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const groupOptions = existingGroups.map((g) => ({ value: g, label: g }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, string | null> = {};
      if (name !== project.name) body.name = name;
      if (rootPath !== project.root_path) body.root_path = rootPath;
      if (description !== (project.description ?? '')) body.description = description;
      const newGroup = groupName.trim() || null;
      if (newGroup !== (project.group_name ?? null)) body.group_name = newGroup;

      if (Object.keys(body).length > 0) {
        await apiPatch(`/projects/${project.id}`, body);
        onSaved(body as Partial<Project>);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4 max-w-xl">
      <h3 className="text-sm font-semibold">{t('settings.nav.general')}</h3>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.nameLabel')}</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.rootPathLabel')}</label>
        <Input value={rootPath} onChange={(e) => setRootPath(e.target.value)} className="font-mono text-xs" required />
        <p className="text-xs text-muted-foreground">{t('edit.rootPathHint')}</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.groupLabel')}</label>
        {groupOptions.length > 0 ? (
          <Combobox
            value={groupName}
            onChange={setGroupName}
            options={groupOptions}
            placeholder={t('edit.groupPlaceholder')}
            searchPlaceholder={t('edit.groupSearchPlaceholder')}
            emptyLabel={t('edit.groupEmptyLabel')}
            allowCustom
            size="md"
          />
        ) : (
          <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder={t('edit.groupInputPlaceholder')} />
        )}
        <p className="text-xs text-muted-foreground">{t('edit.groupHint')}</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.descLabel')}</label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </div>

      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? t('common:actions.saving') : t('common:actions.save')}
        </Button>
        {saved && <span className="text-xs text-emerald-500">{t('settings.saved')}</span>}
      </div>
    </form>
  );
}

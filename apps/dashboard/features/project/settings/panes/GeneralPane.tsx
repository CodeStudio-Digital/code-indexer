/**
 * General project settings — name, root path, group, description. Text fields
 * with server-side validation (unique name, existing root), so this pane keeps
 * an explicit Save (delta PATCH) rather than save-on-keystroke. Extracted from
 * the old ProjectEditDialog.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const groupOptions = useMemo(
    () => existingGroups.map((group) => ({ value: group, label: group })),
    [existingGroups],
  );
  const normalizedGroup = groupName.trim() || null;
  const dirty = name !== project.name
    || rootPath !== project.root_path
    || description !== (project.description ?? '')
    || normalizedGroup !== (project.group_name ?? null);

  useEffect(() => {
    setName(project.name);
    setRootPath(project.root_path);
    setDescription(project.description ?? '');
    setGroupName(project.group_name ?? '');
  }, [project.description, project.group_name, project.id, project.name, project.root_path]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, string | null> = {};
      if (name !== project.name) body.name = name;
      if (rootPath !== project.root_path) body.root_path = rootPath;
      if (description !== (project.description ?? '')) body.description = description;
      if (normalizedGroup !== (project.group_name ?? null)) body.group_name = normalizedGroup;

      if (Object.keys(body).length > 0) {
        await apiPatch(`/projects/${project.id}`, body);
        onSaved(body as Partial<Project>);
      }
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="w-full max-w-3xl">
      <section className="overflow-hidden rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
        <div className="flex h-8 items-center border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('settings.general.title')}
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('edit.nameLabel')}</label>
            <Input className="h-8" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">{t('edit.groupLabel')}</label>
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
              <Input className="h-8" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t('edit.groupInputPlaceholder')} />
            )}
            <p className="text-[11px] text-muted-foreground">{t('edit.groupHint')}</p>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-medium">{t('edit.rootPathLabel')}</label>
            <Input value={rootPath} onChange={(event) => setRootPath(event.target.value)} className="h-8 font-mono text-xs" required />
            <p className="text-[11px] text-muted-foreground">{t('edit.rootPathHint')}</p>
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <label className="text-xs font-medium">{t('edit.descLabel')}</label>
            <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} />
          </div>

          {error && <div className="text-xs text-destructive md:col-span-2">{error}</div>}
        </div>

        <div className="flex min-h-11 items-center justify-between gap-3 border-t border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-4 py-2">
          <span className="text-[11px]" aria-live="polite">
            {dirty ? (
              <span className="text-amber-500">{t('settings.unsaved')}</span>
            ) : saved ? (
              <span className="text-emerald-500">{t('settings.saved')}</span>
            ) : null}
          </span>
          <Button type="submit" size="sm" className="h-8" disabled={saving || !dirty || !name.trim() || !rootPath.trim()}>
            {saving ? t('common:actions.saving') : t('common:actions.save')}
          </Button>
        </div>
      </section>
    </form>
  );
}

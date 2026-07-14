/** Search & indexing settings pane — embeddings toggle + search mode (save-on-change). */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import {
  normalizeIndexIgnoreFolderPattern,
  normalizeIndexIgnorePatterns,
  projectIndexIgnorePatterns,
  serializeIndexIgnorePatterns,
} from '@mcp/shared/utils/index-ignore.js';
import { apiPost } from '../../../../hooks/useApi.js';
import { Button } from '../../../../components/ui/button.js';
import { Combobox } from '../../../../components/ui/combobox.js';
import { Input } from '../../../../components/ui/input.js';
import { Switch } from '../../../../components/ui/switch.js';
import { confirm } from '../../../../components/ui/prompt-dialog.js';
import type { PatchFn } from '../ProjectSettingsModal.js';

interface PurgeIgnoredResult {
  local_deleted: number;
  vectors_known: number;
  vectors_deleted_remote: number;
  tombstoned: number;
  remote_error: string | null;
}

export function SearchPane({ project, patch }: { project: Project; patch: PatchFn }) {
  const { t } = useTranslation(['projects']);
  const embeddings = project.embeddings_enabled !== 0;
  const searchMode = project.search_mode ?? 'hybrid';
  const patterns = useMemo(() => projectIndexIgnorePatterns(project), [project]);
  const searchModeOptions = useMemo(() => [
    { value: 'hybrid', label: t('edit.searchModeHybrid') },
    { value: 'fts', label: t('edit.searchModeFts') },
    { value: 'vector', label: t('edit.searchModeVector') },
  ], [t]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const savePatterns = async (nextPatterns: string[]) => {
    setSaving(true);
    setLocalError(null);
    setNotice(null);
    try {
      await patch({ index_ignore_patterns: serializeIndexIgnorePatterns(nextPatterns) });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addPattern = async () => {
    const normalized = normalizeIndexIgnoreFolderPattern(draft);
    if (!normalized) return;
    const next = normalizeIndexIgnorePatterns([...patterns, normalized]);
    setDraft('');
    await savePatterns(next);
  };

  const removePattern = async (pattern: string) => {
    await savePatterns(patterns.filter((p) => p !== pattern));
  };

  const purgeIgnored = async () => {
    if (!(await confirm({
      title: t('edit.indexIgnorePurgeConfirmTitle'),
      description: t('edit.indexIgnorePurgeConfirmBody'),
      confirmLabel: t('edit.indexIgnorePurge'),
      tone: 'destructive',
    }))) return;
    setPurging(true);
    setLocalError(null);
    setNotice(null);
    try {
      const result = await apiPost<PurgeIgnoredResult>(`/projects/${project.id}/index-ignore/purge`, {});
      setNotice(t('edit.indexIgnorePurgeDone', {
        count: result.local_deleted,
        vectors: result.vectors_known,
      }));
      if (result.remote_error) setLocalError(result.remote_error);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="w-full max-w-3xl space-y-5">

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <label className="text-sm font-medium">{t('edit.embeddingsLabel')}</label>
          <p className="text-xs text-muted-foreground">{t('edit.embeddingsHint')}</p>
        </div>
        <Switch checked={embeddings} onCheckedChange={(v) => void patch({ embeddings_enabled: v ? 1 : 0 })} />
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('edit.searchModeLabel')}</label>
        <Combobox
          value={searchMode}
          onChange={(value) => void patch({ search_mode: value })}
          options={searchModeOptions}
          searchPlaceholder={t('settings.select.search')}
          emptyLabel={t('settings.select.empty')}
          size="md"
        />
        <p className="text-xs text-muted-foreground">{t('edit.searchModeHint')}</p>
      </div>

      <div className="space-y-3 border-t pt-4">
        <div className="space-y-0.5">
          <label className="text-sm font-medium">{t('edit.indexIgnoreLabel')}</label>
          <p className="text-xs text-muted-foreground">{t('edit.indexIgnoreHint')}</p>
        </div>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addPattern();
              }
            }}
            placeholder={t('edit.indexIgnorePlaceholder')}
            disabled={saving}
          />
          <Button type="button" size="icon" onClick={() => void addPattern()} disabled={saving || !draft.trim()} title={t('edit.indexIgnoreAdd')}>
            {saving ? <Loader2 className="animate-spin" /> : <Plus />}
          </Button>
        </div>

        {patterns.length > 0 ? (
          <div className="divide-y rounded-md border">
            {patterns.map((pattern) => (
              <div key={pattern} className="flex min-h-9 items-center justify-between gap-2 px-2">
                <code className="min-w-0 truncate text-xs text-foreground">{pattern}</code>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => void removePattern(pattern)}
                  disabled={saving}
                  title={t('edit.indexIgnoreRemove')}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{t('edit.indexIgnoreEmpty')}</p>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t('edit.indexIgnorePurgeHint')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void purgeIgnored()} disabled={purging}>
            {purging ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t('edit.indexIgnorePurge')}
          </Button>
        </div>
        {notice && <p className="text-xs text-success">{notice}</p>}
        {localError && <p className="text-xs text-destructive">{localError}</p>}
      </div>
    </div>
  );
}

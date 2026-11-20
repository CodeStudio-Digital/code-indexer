import { useEffect, useId, useState } from 'react';
import { ArrowLeft, ChevronRight, Folder, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileTreeNode } from '@mcp/api-bus';
import { normalizeSemanticFolders } from '@mcp/shared/utils/semantic-folders.js';
import { Button } from '../../../components/ui/button.js';
import { apiPut, useApi } from '../../../hooks/useApi.js';
import { apiCall } from '../../../lib/api-client.js';

interface FolderScope {
  folders: string[];
  files: number;
  remote: boolean;
  enabled: boolean;
}

export function SemanticFolderPicker({ projectId, onSaved }: {
  projectId: number;
  onSaved?: (folders: string[]) => void;
}) {
  const { t } = useTranslation('projects');
  const url = `/projects/${projectId}/semantic/folders`;
  const { data, error, refetch } = useApi<FolderScope>(url);
  if (!data) {
    return error ? (
      <div role="alert" className="flex items-center justify-between gap-2 text-xs text-destructive">
        {error}
        <Button type="button" size="sm" variant="outline" onClick={refetch}>{t('index.overview.refresh')}</Button>
      </div>
    ) : <p role="status" className="text-xs text-muted-foreground">{t('index.overview.loading')}</p>;
  }
  return <ScopeEditor key={projectId} projectId={projectId} url={url} initial={data} onSaved={onSaved} />;
}

function ScopeEditor({ projectId, url, initial, onSaved }: {
  projectId: number;
  url: string;
  initial: FolderScope;
  onSaved?: (folders: string[]) => void;
}) {
  const { t } = useTranslation('projects');
  const modeId = useId();
  const [saved, setSaved] = useState(initial.folders);
  const [all, setAll] = useState(initial.folders.includes('.'));
  const [selected, setSelected] = useState(initial.folders.filter((folder) => folder !== '.'));
  const [directory, setDirectory] = useState('.');
  const [listing, setListing] = useState<{ directory: string; folders: FileTreeNode[]; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const folders = all ? ['.'] : selected;
  const changed = JSON.stringify(saved) !== JSON.stringify(folders);
  const query = new URLSearchParams();
  for (const folder of folders) query.append('folder', folder);
  const estimate = useApi<FolderScope>(folders.length ? `${url}?${query}` : '');

  useEffect(() => {
    if (all) return;
    const controller = new AbortController();
    void apiCall<FileTreeNode>('files.tree', { projectId, root: directory, maxDepth: 1 }, { signal: controller.signal })
      .then((tree) => {
        if (!controller.signal.aborted) {
          setListing({ directory, folders: (tree.children ?? []).filter((node) => node.type === 'dir') });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setListing({ directory, folders: [], error: String(error) });
      });
    return () => controller.abort();
  }, [all, directory, projectId]);

  const toggle = (path: string, checked: boolean) => {
    setNotice(false);
    setSelected((current) => checked
      ? normalizeSemanticFolders([...current, path])
      : current.filter((folder) => folder !== path));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(false);
    try {
      const result = await apiPut<Pick<FolderScope, 'folders' | 'files'>>(url, { folders });
      setSaved(result.folders);
      setNotice(true);
      onSaved?.(result.folders);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const visible = listing?.directory === directory ? listing : null;
  const count = folders.length ? (estimate.loading ? undefined : estimate.data?.files) : 0;
  const textStyle = 'text-xs text-muted-foreground';

  return (
    <div className="space-y-3">
      <p className={textStyle}>{t('edit.semanticFoldersHint')}</p>
      <fieldset disabled={saving} className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <legend className="sr-only">{t('edit.semanticFoldersTitle')}</legend>
        <label className="flex items-center gap-2">
          <input name={modeId} type="radio" checked={!all} onChange={() => { setAll(false); setNotice(false); }} />
          {t('edit.semanticSelectedFolders')}
        </label>
        <label className="flex items-center gap-2">
          <input name={modeId} type="radio" checked={all} onChange={() => { setAll(true); setNotice(false); }} />
          {t('edit.semanticWholeProject')}
        </label>
      </fieldset>
      {!all && (
        <>
          <div className="rounded-md border">
            <div className="flex min-h-9 items-center gap-2 border-b px-2">
              <Button type="button" variant="ghost" size="icon-sm" disabled={directory === '.' || saving}
                title={t('edit.semanticParentFolder')} aria-label={t('edit.semanticParentFolder')}
                onClick={() => setDirectory(directory.slice(0, directory.lastIndexOf('/') + 1).replace(/\/$/, '') || '.')}>
                <ArrowLeft />
              </Button>
              <code className="truncate text-xs">{directory}</code>
            </div>
            <ul className="max-h-52 overflow-y-auto px-2 py-1">
              {!visible && <li role="status" className={textStyle}>{t('index.overview.loading')}</li>}
              {visible?.error && <li role="alert" className="text-xs text-destructive">{visible.error}</li>}
              {visible && !visible.error && !visible.folders.length && <li className={textStyle}>{t('edit.semanticNoSubfolders')}</li>}
              {visible?.folders.map((folder) => {
                const inherited = selected.some((root) => folder.path.startsWith(root + '/'));
                return (
                  <li key={folder.path} className="flex min-h-8 items-center gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <input type="checkbox" checked={inherited || selected.includes(folder.path)} disabled={inherited || saving}
                        onChange={(event) => toggle(folder.path, event.target.checked)} />
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate" title={folder.path}>{folder.name}</span>
                    </label>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDirectory(folder.path)}
                      disabled={saving || folder.hasChildren === false}
                      title={t('edit.semanticOpenFolder', { folder: folder.name })}
                      aria-label={t('edit.semanticOpenFolder', { folder: folder.name })}>
                      <ChevronRight />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
          {selected.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {selected.map((path) => (
                <li key={path} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border pl-2">
                  <code className="truncate text-xs" title={path}>{path}</code>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={saving} onClick={() => toggle(path, false)}
                    title={t('edit.semanticRemoveFolder', { folder: path })}
                    aria-label={t('edit.semanticRemoveFolder', { folder: path })}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {initial.remote && initial.enabled && <p className={textStyle}>{t('edit.semanticFoldersRemote')}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className={textStyle}>
          {estimate.error ? t('edit.semanticCountUnavailable')
            : count === undefined ? t('edit.semanticCountingFiles') : t('edit.semanticFileCount', { count })}
        </p>
        <Button type="button" size="sm" disabled={!changed || !folders.length || saving} onClick={() => void save()}>
          {saving && <Loader2 className="animate-spin" />}
          {t(initial.enabled ? 'edit.semanticFoldersSaveAndIndex' : 'edit.semanticFoldersSave')}
        </Button>
      </div>
      {notice && <p role="status" className="text-xs text-success">{t('edit.semanticFoldersSaved')}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

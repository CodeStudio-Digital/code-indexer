import { useState } from 'react';
import { Eye, FileText, FolderKey, FolderOpen, Loader2, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { apiDelete, apiPost, useApi } from '../../../hooks/useApi.js';

type FilesystemAccess = 'read' | 'write';

interface SessionFilesystemRoot {
  id: string;
  root_path: string;
  access: FilesystemAccess;
  kind?: 'directory' | 'file';
}

interface RootsResponse {
  roots: SessionFilesystemRoot[];
}

interface SessionFilesystemRootsControlProps {
  sessionId: string;
  streaming: boolean;
}

export function SessionFilesystemRootsControl({
  sessionId,
  streaming,
}: SessionFilesystemRootsControlProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, refetch } = useApi<RootsResponse>(
    `/coder/sessions/${sessionId}/filesystem-roots`,
  );
  const roots = data?.roots ?? [];

  const browse = async () => {
    setError(null);
    if (!window.electronAPI?.openDirectory) {
      setError(t('filesystemRoots.pickerUnavailable'));
      return;
    }
    try {
      const selected = await window.electronAPI.openDirectory();
      if (selected) setPath(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const save = async (rootPath: string, access: FilesystemAccess) => {
    if (!rootPath.trim() || streaming) return;
    setBusy(`${access}:${rootPath}`);
    setError(null);
    try {
      await apiPost(`/coder/sessions/${sessionId}/filesystem-roots`, {
        path: rootPath.trim(),
        access,
      });
      setPath('');
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (root: SessionFilesystemRoot) => {
    if (streaming) return;
    setBusy(`delete:${root.id}`);
    setError(null);
    try {
      await apiDelete(`/coder/sessions/${sessionId}/filesystem-roots/${root.id}`);
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('filesystemRoots.title')}
        className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          roots.length > 0
            ? 'bg-blue-500/15 text-blue-500 hover:bg-blue-500/25'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        <FolderKey className="h-3.5 w-3.5" />
        {roots.length > 0 && (
          <span className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-blue-500 px-0.5 text-center text-[9px] leading-3.5 text-white">
            {roots.length}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('filesystemRoots.title')}</DialogTitle>
            <DialogDescription>{t('filesystemRoots.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {streaming && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                {t('filesystemRoots.nextRun')}
              </div>
            )}
            {error && (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="flex min-w-0 gap-2">
              <Input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t('filesystemRoots.pathPlaceholder')}
                className="min-w-0 flex-1 font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={() => void browse()} className="gap-1.5">
                <FolderOpen className="h-4 w-4" />
                {t('filesystemRoots.browse')}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!path.trim() || busy != null || streaming}
                onClick={() => void save(path, 'read')}
                className="gap-1.5"
              >
                <Eye className="h-4 w-4" />
                {t('filesystemRoots.addRead')}
              </Button>
              <Button
                type="button"
                disabled={!path.trim() || busy != null || streaming}
                onClick={() => void save(path, 'write')}
                className="gap-1.5"
              >
                <Pencil className="h-4 w-4" />
                {t('filesystemRoots.addWrite')}
              </Button>
            </div>

            <div className="overflow-hidden rounded border">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('filesystemRoots.loading')}
                </div>
              ) : roots.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t('filesystemRoots.empty')}
                </div>
              ) : (
                <div className="divide-y">
                  {roots.map((root) => (
                    <div key={root.id} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
                      {root.kind === 'file'
                        ? <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                        : root.access === 'write'
                        ? <Pencil className="h-4 w-4 shrink-0 text-amber-500" />
                        : <Eye className="h-4 w-4 shrink-0 text-blue-500" />}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs" title={root.root_path}>{root.root_path}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {root.kind === 'file'
                            ? `${t('filesystemRoots.read')} · attachment`
                            : root.access === 'write' ? t('filesystemRoots.write') : t('filesystemRoots.read')}
                        </div>
                      </div>
                      {root.kind !== 'file' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy != null || streaming}
                          onClick={() => void save(root.root_path, root.access === 'write' ? 'read' : 'write')}
                        >
                          {root.access === 'write' ? t('filesystemRoots.makeRead') : t('filesystemRoots.allowWrite')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={busy != null || streaming}
                        onClick={() => void remove(root)}
                        aria-label={t('filesystemRoots.remove')}
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      >
                        {busy === `delete:${root.id}`
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('filesystemRoots.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

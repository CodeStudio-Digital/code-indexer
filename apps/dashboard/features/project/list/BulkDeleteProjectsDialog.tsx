import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FolderGit2, LoaderCircle, Trash2 } from 'lucide-react';
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
import { apiPost } from '../../../hooks/useApi.js';
import type { ProjectCardData } from './ProjectCard.js';

export interface BulkProjectDeleteItemResult {
  id: number;
  name: string;
  root_path: string;
  catalog_deleted: boolean;
  folder_status: 'not_requested' | 'deleted' | 'already_missing' | 'skipped' | 'failed';
  error: string | null;
}

export interface BulkProjectDeleteResponse {
  ok: boolean;
  projects_deleted: number;
  folders_deleted: number;
  folders_missing: number;
  results: BulkProjectDeleteItemResult[];
}

interface BulkDeleteProjectsDialogProps {
  open: boolean;
  projects: ProjectCardData[];
  onOpenChange: (open: boolean) => void;
  onCompleted: (result: BulkProjectDeleteResponse) => void;
}

export function BulkDeleteProjectsDialog({
  open,
  projects,
  onOpenChange,
  onCompleted,
}: BulkDeleteProjectsDialogProps) {
  const { t } = useTranslation(['projects', 'common']);
  const deleteFoldersId = useId();
  const [deleteFolders, setDeleteFolders] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmationWord = t('projects:bulkDelete.confirmationWord');
  const canSubmit = !deleting
    && projects.length > 0
    && (!deleteFolders || confirmation.trim() === confirmationWord);

  useEffect(() => {
    if (!open) return;
    setDeleteFolders(false);
    setConfirmation('');
    setDeleting(false);
    setError(null);
  }, [open]);

  async function handleDelete() {
    if (!canSubmit) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await apiPost<BulkProjectDeleteResponse>('/projects/bulk-delete', {
        projectIds: projects.map((project) => project.id),
        confirm: true,
        deleteFolders,
        folderConfirmation: deleteFolders ? 'DELETE_FOLDERS' : undefined,
      });
      onOpenChange(false);
      onCompleted(result);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!deleting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('projects:bulkDelete.title', { count: projects.length })}</DialogTitle>
          <DialogDescription>
            {t('projects:bulkDelete.description', { count: projects.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2">
          {projects.map((project) => (
            <div key={project.id} className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5">
              <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{project.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {project.root_path}
                </span>
              </span>
            </div>
          ))}
        </div>

        <label
          htmlFor={deleteFoldersId}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
        >
          <input
            id={deleteFoldersId}
            type="checkbox"
            checked={deleteFolders}
            onChange={(event) => {
              setDeleteFolders(event.target.checked);
              setConfirmation('');
              setError(null);
            }}
            disabled={deleting}
            className="mt-0.5 h-4 w-4 shrink-0 accent-destructive"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-destructive">
              {t('projects:bulkDelete.deleteFolders')}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {t('projects:bulkDelete.deleteFoldersHint')}
            </span>
          </span>
        </label>

        {deleteFolders && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-xs leading-relaxed">
                {t('projects:bulkDelete.permanentWarning')}
              </p>
            </div>
            <label className="block space-y-1.5 text-xs font-medium">
              <span>
                {t('projects:bulkDelete.typeToConfirm', { word: confirmationWord })}
              </span>
              <Input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={confirmationWord}
                disabled={deleting}
                autoComplete="off"
                className="h-8 font-mono"
              />
            </label>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={!canSubmit}>
            {deleting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {deleting
              ? t('projects:bulkDelete.deleting')
              : t('projects:bulkDelete.confirm', { count: projects.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

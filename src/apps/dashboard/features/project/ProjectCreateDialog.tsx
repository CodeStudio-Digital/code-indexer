import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderGit2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { apiPost } from '../../hooks/useApi.js';

interface CreatedProject {
  id: number;
  name: string;
  root_path: string;
}

interface ProjectCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: CreatedProject) => void;
}

/**
 * Create a project by picking/typing a folder path. The backend validates
 * that the path exists + is a directory and that neither the name nor the
 * root_path clash with an existing project.
 *
 * We keep it simple: no file browser (the HTTP API runs on the host and
 * the dashboard is a static bundle), just a raw text field for the path —
 * this matches what users already type in the CLI.
 */
export default function ProjectCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: ProjectCreateDialogProps) {
  const { t } = useTranslation(['projects', 'common']);
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setRootPath('');
    setName('');
    setDescription('');
    setError(null);
    setSaving(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedPath = rootPath.trim();
    if (!trimmedPath) {
      setError(t('projects:create.errorRequired'));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, string> = { root_path: trimmedPath };
      if (name.trim()) body.name = name.trim();
      if (description.trim()) body.description = description.trim();
      const created = await apiPost<CreatedProject>('/projects', body);
      onCreated(created);
      reset();
      onOpenChange(false);
    } catch (err) {
      // apiPost throws a generic `HTTP 4xx` — try to surface the server's
      // JSON error if the response is still readable. For now we keep it
      // simple and show the raw message.
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('409')) {
        setError(t('projects:create.errorConflict'));
      } else if (raw.includes('400')) {
        setError(t('projects:create.errorInvalid'));
      } else {
        setError(raw);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <FolderGit2 className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle>{t('projects:create.title')}</DialogTitle>
              <DialogDescription>
                {t('projects:create.description')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('projects:create.folderLabel')} <span className="text-destructive">*</span>
            </label>
            <Input
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder={t('projects:create.folderPlaceholder')}
              className="font-mono text-xs"
              autoFocus
              required
            />
            <p className="text-xs text-muted-foreground">
              {t('projects:create.folderHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('projects:create.nameLabel')}</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('projects:create.namePlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('projects:create.nameHint')}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('projects:create.descLabel')}</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder={t('projects:create.descPlaceholder')}
            />
          </div>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={saving || !rootPath.trim()}>
              {saving ? t('projects:create.creating') : t('projects:create.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

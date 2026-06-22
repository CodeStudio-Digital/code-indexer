/** Danger zone — delete the project (two-step confirm). Extracted from ProjectEditDialog. */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { Button } from '../../../../components/ui/button.js';
import { apiDelete } from '../../../../hooks/useApi.js';

export function DangerPane({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const { t } = useTranslation(['projects', 'common']);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/projects/${project.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConfirm(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4 max-w-xl">
      <h3 className="text-sm font-semibold text-destructive">{t('settings.nav.danger')}</h3>
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 space-y-3">
        <p className="text-sm font-medium">{t('edit.deleteBtn')}</p>
        <p className="text-xs text-muted-foreground">{t('settings.dangerHint')}</p>
        {confirm ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive font-medium">{t('edit.deleteConfirm', { name: project.name })}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirm(false)} disabled={deleting}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={deleting}>
                {deleting ? t('edit.deleting') : t('edit.deleteConfirmBtn')}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => setConfirm(true)}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            {t('edit.deleteBtn')}
          </Button>
        )}
        {error && <div className="text-sm text-destructive">{error}</div>}
      </div>
    </div>
  );
}

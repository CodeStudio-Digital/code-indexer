import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { importPostman, type PostmanPreview } from './api.js';

interface Props { projectId: number; onClose: () => void; onImported: (id: number) => Promise<void> }

export function ImportPostmanDialog({ projectId, onClose, onImported }: Props) {
  const { t } = useTranslation('apiClient');
  const [file, setFile] = useState<{ content: string; id: string; preview: PostmanPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState(false);
  const [error, setError] = useState('');
  async function preview(selected?: File) {
    if (!selected) return;
    setFile(null); setEnv(false); setError('');
    if (selected.size > 2 * 1024 * 1024) { setError(t('postman.limit')); return; }
    setBusy(true);
    try {
      const content = await selected.text(), id = crypto.randomUUID();
      setFile({ content, id, preview: await importPostman(projectId, content, id, false) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function commit() {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const result = await importPostman(projectId, file.content, file.id, true, env);
      if (result.collectionId == null) throw new Error(t('postman.failed'));
      await onImported(result.collectionId);
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const info = file?.preview;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{t('postman.title')}</DialogTitle></DialogHeader>
      <input type="file" accept=".json,application/json" aria-label={t('postman.file')} disabled={busy}
        className="w-full text-xs file:mr-2 file:rounded file:border file:bg-background file:px-2 file:py-1.5 file:text-foreground"
        onChange={event => { void preview(event.target.files?.[0]); }} />
      {info && <div className="space-y-2 text-sm">
        <p className="font-medium">{info.name}</p>
        <p>{t('postman.requests', { count: info.requests })} · {t('postman.folders', { count: info.folders })}</p>
        {!!(info.scripts || info.examples || info.skipped) && <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('postman.omitted')} {[
            info.scripts > 0 && t('postman.scripts', { count: info.scripts }),
            info.examples > 0 && t('postman.examples', { count: info.examples }),
            info.skipped > 0 && t('postman.skipped', { count: info.skipped }),
          ].filter(Boolean).join(' · ')}
        </p>}
        {info.variables > 0 && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={env} onChange={e => setEnv(e.target.checked)} />{t('postman.env', { count: info.variables })}</label>}
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t('importCurl.cancel')}</Button>
        <Button size="sm" disabled={!info || busy || (!info.requests && !info.folders)} onClick={() => void commit()}>{t('postman.create')}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

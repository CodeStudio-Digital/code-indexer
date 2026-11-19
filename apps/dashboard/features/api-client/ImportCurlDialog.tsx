/**
 * Import a request from a pasted curl/bash command into the active collection
 * (creating one if needed). The full parse runs server-side (one source of truth).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import * as api from './api.js';

interface Props {
  projectId: number;
  collectionId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImported: (collectionId: number, requestId: number) => void;
  ensureCollection: () => Promise<number>;
}

export function ImportCurlDialog({ projectId, collectionId, open, onOpenChange, onImported, ensureCollection }: Props) {
  const { t } = useTranslation('apiClient');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const cid = collectionId ?? await ensureCollection();
      const request = await api.importCurl(projectId, cid, text);
      await onImported(cid, request.id);
      setText('');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{t('importCurl.title')}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">{t('importCurl.descBefore')} <code>curl</code> {t('importCurl.descAfter')}</p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"curl -X POST https://api.example.com/users \\\n  -H 'Authorization: Bearer {{token}}' \\\n  -d '{\"name\":\"joe\"}'"}
          className="h-48 font-mono text-xs resize-none"
        />
        {error && <div className="text-xs text-red-500">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('importCurl.cancel')}</Button>
          <Button size="sm" disabled={busy || !text.trim()} onClick={run} className="gap-1">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {t('importCurl.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

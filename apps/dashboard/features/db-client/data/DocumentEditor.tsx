/**
 * JSON document editor (Mongo) — edit/insert a document as JSON in Monaco, then
 * save (updateOne by `_id` / insertOne) or delete. Reuses the api-client's
 * LazyMonaco + the app Dialog.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { LazyMonaco } from '../../api-client/LazyMonaco.js';

export function DocumentEditor({
  initial,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  initial: string;
  isNew: boolean;
  onSave: (text: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('docs.newTitle') : t('docs.editTitle')}</DialogTitle>
        </DialogHeader>
        <div className="h-[50vh] overflow-hidden rounded border">
          <LazyMonaco value={text} language="json" onChange={setText} height="100%" />
        </div>
        <DialogFooter className="gap-2">
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-red-400"
              disabled={busy}
              onClick={async () => {
                if (!(await confirm({ title: t('docs.deleteConfirm'), tone: 'destructive' }))) return;
                setBusy(true);
                try {
                  await onDelete();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 className="mr-1.5 h-3 w-3" />
              {t('docs.delete')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('edit.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(text);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            {t('docs.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

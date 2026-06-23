/**
 * "Preview then apply" dialog — shows the generated SQL (UPDATE/INSERT/DELETE or
 * CREATE/ALTER/DROP) read-only before it runs. The app's standard safety gate
 * for any data/structure mutation.
 */
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';

export function SqlPreviewDialog({
  open,
  sql,
  executing,
  onExecute,
  onClose,
}: {
  open: boolean;
  sql: string;
  executing: boolean;
  onExecute: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('dbClient');
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !executing && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('edit.previewTitle')}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[50vh] overflow-auto rounded border bg-background p-3 font-mono text-xs whitespace-pre-wrap">
          {sql || t('edit.nothing')}
        </pre>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={executing}>
            {t('edit.cancel')}
          </Button>
          <Button size="sm" onClick={onExecute} disabled={executing || !sql}>
            {executing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            {t('edit.execute')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cell value viewer — opens the full content of a cell (long text, JSON, BLOB)
 * that the grid truncates. Pretty-prints JSON; offers copy. Reuses the app's
 * Dialog + clipboard helpers.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { copyText } from '../../../lib/clipboard.js';

function pretty(value: unknown): { text: string; isJson: boolean } {
  if (value == null) return { text: 'NULL', isJson: false };
  if (typeof value === 'object') return { text: JSON.stringify(value, null, 2), isJson: true };
  const s = String(value);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return { text: JSON.stringify(JSON.parse(s), null, 2), isJson: true };
    } catch {
      /* not JSON */
    }
  }
  return { text: s, isJson: false };
}

export function CellValuePanel({
  open,
  column,
  value,
  onClose,
}: {
  open: boolean;
  column: string;
  value: unknown;
  onClose: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const { text } = useMemo(() => pretty(value), [value]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{column}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded border bg-background p-3 font-mono text-xs whitespace-pre-wrap break-all">
          {text}
        </pre>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (await copyText(text)) toast.success(t('grid.copied'));
            }}
          >
            <Copy className="mr-1.5 h-3 w-3" />
            {t('grid.copy')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

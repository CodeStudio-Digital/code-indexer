/**
 * Shared transfer progress strip at the bottom of the dual-pane manager. Both
 * panes feed the same list (lifted out of the old single-pane SftpBrowser).
 * Cancel ends only that transfer's dedicated channel (via `sftpCancel`).
 */

import { Download, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Transfer } from './transfer-controller.js';

export function TransferBar({ transfers, onCancel }: { transfers: Transfer[]; onCancel: (id: string) => void }) {
  const { t } = useTranslation('ssh');
  if (transfers.length === 0) return null;
  return (
    <div className="shrink-0 border-t max-h-28 overflow-y-auto">
      {transfers.map((tf) => {
        const pct = tf.total > 0 ? Math.min(100, Math.round((tf.transferred / tf.total) * 100)) : 0;
        return (
          <div key={tf.id} className="px-3 py-1 text-[11px] flex items-center gap-2">
            {tf.dir === 'up' ? <Upload className="h-3 w-3 shrink-0" /> : <Download className="h-3 w-3 shrink-0" />}
            <span className="truncate flex-1">{tf.name}</span>
            {tf.cancelled ? (
              <span className="text-muted-foreground shrink-0">{t('sftp.cancelled')}</span>
            ) : tf.error ? (
              <span className="text-red-500 shrink-0" title={tf.error}>
                {tf.error}
              </span>
            ) : (
              <span className="text-muted-foreground tabular-nums shrink-0">{tf.done ? '100%' : `${pct}%`}</span>
            )}
            {!tf.done && !tf.cancelled && (
              <button
                type="button"
                aria-label={t('sftp.cancel')}
                title={t('sftp.cancel')}
                className="shrink-0 p-0.5 text-muted-foreground hover:text-red-500"
                onClick={() => onCancel(tf.id)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

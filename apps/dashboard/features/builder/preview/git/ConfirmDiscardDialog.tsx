import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';

interface Props {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDiscardDialog({
  title,
  message,
  confirmLabel = 'Descartar',
  busy = false,
  error,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="bg-card rounded-lg border shadow-lg w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>

        <div className="p-5 space-y-3">
          <div className="text-sm text-muted-foreground">{message}</div>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Esta ação não pode ser desfeita.
          </div>
          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void onConfirm()} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Descartando…
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

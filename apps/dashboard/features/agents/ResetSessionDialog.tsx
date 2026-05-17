import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiPost } from '../../hooks/useApi.js';

interface ResetSessionDialogProps {
  sessionId: number;
  sessionName: string;
  /**
   * True when the session was created in builder mode — shows the
   * "teardown container" checkbox. When false, the checkbox is hidden
   * and `teardown_sandbox` is not sent.
   */
  builderMode: boolean;
  onClose: () => void;
  onResetDone: () => void;
}

/**
 * Dialog that archives all current conversations (master + subordinates
 * + board + optionally kanban/sandbox) and flips the session back to
 * `idle` so the next prompt starts fresh. Used after code updates to
 * prompts/templates when the operator doesn't want to recreate sessions.
 */
export function ResetSessionDialog({
  sessionId,
  sessionName,
  builderMode,
  onClose,
  onResetDone,
}: ResetSessionDialogProps) {
  const [reason, setReason] = useState('');
  const [archiveKanban, setArchiveKanban] = useState(true);
  const [teardownSandbox, setTeardownSandbox] = useState(builderMode);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    setSubmitting(true);
    setError(null);
    try {
      await apiPost(`/company/sessions/${sessionId}/reset`, {
        reason: reason.trim() || undefined,
        archive_kanban: archiveKanban,
        teardown_sandbox: builderMode ? teardownSandbox : false,
      });
      onResetDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-lg border shadow-lg w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Resetar sessão</h2>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Arquivar todas as conversas da sessão <span className="font-medium text-foreground">{sessionName}</span>{' '}
            e voltar ao estado inicial. O próximo prompt cria um novo master
            do zero — útil após atualizações em prompts/templates.
          </p>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Motivo (opcional)</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ex: aplicando novos prompts de master"
              className="w-full mt-1 rounded-md border bg-background px-2 py-1.5 text-sm resize-none"
            />
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={archiveKanban}
              onChange={(e) => setArchiveKanban(e.target.checked)}
              className="mt-0.5 rounded border-gray-300"
            />
            <div>
              <div className="font-medium">Também arquivar cards do Kanban</div>
              <div className="text-[11px] text-muted-foreground">
                Desmarque para manter os cards atuais no board após o reset.
              </div>
            </div>
          </label>

          {builderMode && (
            <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={teardownSandbox}
                onChange={(e) => setTeardownSandbox(e.target.checked)}
                className="mt-0.5 rounded border-gray-300"
              />
              <div>
                <div className="font-medium">Derrubar o container sandbox</div>
                <div className="text-[11px] text-muted-foreground">
                  Marque para provisionar um container novo no próximo prompt.
                  Desmarque para preservar o workdir atual.
                </div>
              </div>
            </label>
          )}

          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Todas as conversas atuais ficarão visíveis apenas na aba Arquivadas.
            A sessão voltará ao estado idle.
          </div>

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleReset}
            disabled={submitting}
          >
            {submitting ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Arquivando…</>
            ) : (
              'Resetar'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

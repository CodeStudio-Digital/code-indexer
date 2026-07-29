import { useState } from 'react';
import { Loader2, Wrench } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { apiPost } from '../../hooks/useApi.js';

interface ReestablishMasterDialogProps {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  /** Called with the new master coder_session_id on success — parent navigates. */
  onSpawned: (args: { masterCoderSessionId: string }) => void;
}

interface SpawnResponse {
  ok?: boolean;
  master_coder_session_id?: string;
  company_session_id?: string;
  provider?: string;
  model?: string;
  error?: string;
  detail?: string;
}

/**
 * Phase H — Reestabelecer Master dialog.
 *
 * Spawns a one-shot recovery agent that audits the kanban board + master
 * state and repairs inconsistencies (missing cards, stuck columns,
 * unchecked objectives, missing goal). The recovery agent runs in a
 * NEW coder session so the broken master's history stays intact for
 * forensic review.
 *
 * Mirrors the visual pattern of `ResetSessionDialog` (inline backdrop +
 * card) so the experience feels consistent with other admin/recovery
 * actions in the same view.
 */
export function ReestablishMasterDialog({
  sessionId,
  sessionName,
  onClose,
  onSpawned,
}: ReestablishMasterDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSpawn() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<SpawnResponse>(
        `/company/sessions/${sessionId}/reestablish-master`,
        {},
      );
      if (!result.ok || !result.master_coder_session_id) {
        setError(result.detail ?? result.error ?? 'Unknown error from recovery route.');
        return;
      }
      onSpawned({ masterCoderSessionId: result.master_coder_session_id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg border shadow-lg w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b flex items-center gap-2">
          <Wrench className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Reestabelecer Master</h2>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Inicia um <span className="font-medium text-foreground">novo master</span> para{' '}
            <span className="font-medium text-foreground">{sessionName}</span> com briefing de
            recovery profundo. O novo master audita tudo, repara o estado, e continua o trabalho
            que o master anterior abandonou.
          </p>

          <div className="rounded-md border bg-muted/30 px-3 py-2.5 space-y-1.5 text-xs">
            <div className="font-medium text-foreground">Fluxo em 4 fases:</div>
            <ul className="space-y-1 text-muted-foreground list-decimal ml-4">
              <li>
                <span className="font-medium text-foreground">Audit</span> — lê board completo,
                lista todos os cards, busca detalhes de cada um em flight, checa goal e
                subordinates órfãos
              </li>
              <li>
                <span className="font-medium text-foreground">Document</span> — posta findings
                estruturados no board (inconsistências, cards promised, checklist stale, goal
                ausente)
              </li>
              <li>
                <span className="font-medium text-foreground">Repair</span> — cria cards
                faltantes, move stuck, marca objetivos done, define goal se vazio, comenta cada
                card reparado
              </li>
              <li>
                <span className="font-medium text-foreground">Resume</span> — assume como master
                ativo, delega trabalho restante a subordinates, finaliza o que ficou pendente
              </li>
            </ul>
          </div>

          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            O master anterior fica no DB como histórico. O novo master usa o mesmo
            provider/model/role_assignments. Esta operação inicia o LLM imediatamente — gasta
            tokens.
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
            variant="default"
            size="sm"
            onClick={handleSpawn}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Iniciando…
              </>
            ) : (
              <>
                <Wrench className="h-3.5 w-3.5 mr-1" /> Iniciar Novo Master
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

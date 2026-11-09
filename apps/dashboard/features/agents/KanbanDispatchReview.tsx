import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { AgentSessionModal } from './AgentSessionModal.js';
import { readDispatchReview, submitDispatchReview, type DispatchReview } from './kanban-dispatch-review-api.js';

export function DispatchReviewNotice({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null;
}

export function KanbanDispatchReview({ sessionId, cardId, onChanged }: { sessionId: string; cardId: string; onChanged: () => void }) {
  const [data, setData] = useState<DispatchReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [inspection, setInspection] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void readDispatchReview(sessionId, cardId, abort.signal).then(next => {
      if (!abort.signal.aborted) setData(next);
    }).catch(e => {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    });
    return () => abort.abort();
  }, [sessionId, cardId, revision]);
  const refresh = useCallback(() => {
    setError(null); setReviewed(false); setRevision(value => value + 1);
  }, []);
  async function release() {
    if (!reviewed || !data?.reviewable || !data.claim || busy) return;
    setBusy(true); setError(null);
    try {
      await submitDispatchReview(sessionId, cardId, data.claim);
      setReviewed(false); onChanged(); refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (!data?.pending && !error && !data?.claim?.review?.completedAt) return null;
  return <section className="mt-4 space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
    <div className="flex items-center justify-between gap-2"><h4 className="font-medium">{data?.pending ? 'Revisar despacho pendente' : data?.claim?.review?.completedAt ? 'Despacho revisado' : 'Verificar despacho'}</h4><Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>Atualizar</Button></div>
    <DispatchReviewNotice error={error} />
    {data?.pending && data.claim && <>
      <p className="text-muted-foreground">Confira os arquivos, processos e a conversa da execução anterior. Liberar a reserva mantém o cartão em revisão e não inicia outro agente nem transforma o resultado anterior em sucesso.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-words">
        <dt>Sessão</dt><dd>{data.owner?.sessionName ?? 'Indisponível'} · {data.owner?.sessionStatus}</dd>
        <dt>Agente</dt><dd>{data.owner?.role ?? 'Inicialização interrompida'} · {data.owner?.runStatus ?? 'Sem registro de execução'}</dd>
        <dt>Execução</dt><dd className="break-all font-mono">{data.owner?.agentRunId}</dd>
        <dt>Início</dt><dd>{new Date(data.claim.createdAt ?? data.claim.leaseUntil - 60_000).toLocaleString()}</dd>
      </dl>
      {(data.claim.error || data.owner?.statusMessage) && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background p-2">{data.claim.error || data.owner?.statusMessage}</pre>}
      {data.owner?.coderSessionId && <Button size="sm" variant="outline" onClick={() => setInspection(true)}>Ver conversa da execução</Button>}
      {data.blockingReason && <p className="text-amber-500">{data.blockingReason}</p>}
      {data.pendingEffects?.map(effect => <p key={effect.toolUseId} className="break-all font-mono text-muted-foreground">{effect.toolName} · {effect.toolUseId} · {effect.phase}</p>)}
      <label className="flex items-start gap-2"><input type="checkbox" checked={reviewed} disabled={busy || !data.reviewable} onChange={event => setReviewed(event.target.checked)} />Conferi os arquivos e processos; a execução anterior está encerrada.</label>
      <Button size="sm" variant="outline" disabled={busy || !reviewed || !data.reviewable} onClick={() => void release()}>{busy ? 'Registrando revisão…' : 'Liberar reserva e manter em revisão'}</Button>
    </>}
    {data && !data.pending && data.claim?.review?.completedAt && <p>Reserva liberada. Para iniciar outro agente, mova o cartão para A fazer e escolha o agente em Despachar. O resultado anterior permanece inalterado.</p>}
    {inspection && data?.owner?.coderSessionId && <AgentSessionModal coderSessionId={data.owner.coderSessionId} role={data.owner.role ?? 'agente'} status={data.owner.runStatus ?? 'interrupted'} onClose={() => setInspection(false)} />}
  </section>;
}

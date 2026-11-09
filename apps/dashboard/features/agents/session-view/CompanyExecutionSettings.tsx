import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApi } from '../../../hooks/useApi.js';
import { Button } from '../../../components/ui/button.js';
import type { CompanySession } from '@mcp/company-contracts';
import { parseConfig } from './types.js';
import { AgentSessionModal } from '../AgentSessionModal.js';

interface Owner { token: string; sessionId: string; agentRunId: string; toolUseId: string; startedAt: number; toolName: string; phase: 'running' | 'uncertain'; reviewable?: boolean }
export interface CompanyExecutionFamily {
  parent: CompanySession | null;
  children: CompanySession[];
  error: string | null;
  refresh: () => void | Promise<void>;
}
export function CompanyExecutionSettings({ companyId, sessionId, family, revision, onChanged }: {
  companyId: string; sessionId: string; family: CompanyExecutionFamily; revision: number; onChanged: () => void;
}) {
  const workspace = useApi<{ owners: Owner[] }>(`/company/companies/${companyId}/workspace`);
  const refreshWorkspace = workspace.refetch;
  useEffect(() => {
    if (!revision) return;
    const timer = setTimeout(refreshWorkspace, 300);
    return () => clearTimeout(timer);
  }, [revision, refreshWorkspace]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{ coderSessionId: string; role: string; status: string } | null>(null);
  async function inspect(owner: Owner) {
    setError(null);
    try {
      const response = await fetch(`/api/company/sessions/${owner.sessionId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const full = await response.json() as { session: { master_session_id?: string }; agentRuns: Array<{ id: string; coder_session_id: string; role: string; status: string }> };
      const run = full.agentRuns.find(run => run.id === owner.agentRunId);
      const id = run?.coder_session_id ?? (owner.agentRunId === '__master__' ? full.session.master_session_id : undefined);
      if (!id) throw new Error('Conversa da operação não encontrada. Confira o ID da chamada e os arquivos antes de revisar.');
      setInspection({ coderSessionId: id, role: `${run?.role ?? 'master'} · ${owner.toolUseId}`, status: run?.status ?? 'paused' });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const session = family.children.find(s => s.id === sessionId);
  const parent = family.parent;
  const differentConfig = session?.configuration?.revision && parent?.configuration?.revision
    && session.configuration.revision !== parent.configuration.revision;
  async function adopt() {
    if (!session?.configuration || !parent?.configuration || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/company/companies/${companyId}/sessions/${sessionId}/config/adopt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedCompanyRevision: parent.configuration.revision, expectedSessionRevision: session.configuration.revision }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const owners = workspace.data?.owners ?? [];
  return <div className="space-y-3 border-b px-3 py-3 text-xs">
    <div className="flex items-center gap-2"><span className="font-medium">Sessões e espaço de trabalho</span><button type="button" aria-label="Atualizar coordenação" className="ml-auto text-muted-foreground" onClick={() => { void family.refresh(); workspace.refetch(); }}><RefreshCw className="size-3.5" /></button></div>
    <p className="text-muted-foreground">Conversa e agentes separados por sessão. Documentos e arquivos compartilhados; escritas entre sessões são coordenadas.</p>
    {differentConfig && <details className="rounded border p-2">
      <summary className="cursor-pointer">Configuração diferente da empresa</summary>
      <p className="my-2 text-muted-foreground">A sessão mantém a configuração copiada ao criar. Adotar substitui os ajustes desta sessão pelos atuais da empresa, quando não houver execução ativa.</p>
      <details><summary className="cursor-pointer text-[11px]">Comparar configurações</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify({ sessão: parseConfig(session!.config_json), empresa: parseConfig(parent!.config_json) }, null, 2)}</pre></details>
      <Button className="mt-2 h-7" size="sm" variant="outline" disabled={busy || session?.status === 'running' || session?.status === 'paused'} onClick={() => void adopt()}>Adotar configuração da empresa</Button>
    </details>}
    {owners.length > 0 && <div className="space-y-1 rounded border p-2">
      <span className="font-medium">Operações no espaço compartilhado</span>
      {owners.map(owner => <div key={owner.token} className="space-y-1 py-1 text-[11px] text-muted-foreground"><p className="break-words">{[family.parent, ...family.children].find(s => s?.id === owner.sessionId)?.name || owner.sessionId} · {owner.toolName} · {owner.phase === 'uncertain' || owner.reviewable ? 'resultado pendente' : 'em execução'}</p><p className="break-all font-mono text-[10px]">{owner.toolUseId}</p><p>{new Date(owner.startedAt).toLocaleString()}</p><button type="button" className="text-primary" onClick={() => void inspect(owner)}>Ver conversa e resultado da operação</button></div>)}
      {owners.some(o => o.phase === 'uncertain' || o.reviewable) && <WorkspaceReview key={owners.map(o => o.token).join(':')} companyId={companyId} owners={owners.filter(o => o.phase === 'uncertain' || o.reviewable)} onChanged={workspace.refetch} />}
    </div>}
    {(error || workspace.error || family.error) && <p role="alert" className="text-destructive">{error || workspace.error || family.error}</p>}
    {inspection && <AgentSessionModal {...inspection} onClose={() => setInspection(null)} />}
  </div>;
}

function WorkspaceReview({ companyId, owners, onChanged }: { companyId: string; owners: Owner[]; onChanged: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function reconcile() {
    if (!reviewed || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/company/companies/${companyId}/workspace/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed: true, tokens: owners.map(o => o.token) }) });
      if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 border-t pt-2">
    <p className="text-muted-foreground">Confira os arquivos e processos da operação e pause a sessão responsável antes de liberar novas escritas. A revisão não repete a operação nem transforma o resultado em sucesso.</p>
    <label className="flex gap-2"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />Conferi o estado das operações listadas.</label>
    <Button size="sm" variant="outline" disabled={!reviewed || busy} onClick={() => void reconcile()}>Liberar operações revisadas</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}

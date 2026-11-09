import { useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';
import { Button } from '../../components/ui/button.js';

/** Explicit addressing avoids broadcasting instructions to a same-named role. */
export function SessionMessageComposer({ companyId, sessionId, onSent }: { companyId: string; sessionId: string; onSent: () => void }) {
  const { data, error: loadError } = useApi<{ sessions: Array<{ id: string; name: string; status: string }> }>(`/company/companies/${companyId}/sessions`);
  const [target, setTarget] = useState(sessionId);
  const [role, setRole] = useState('master');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  async function send() {
    if (!body.trim() || !role.trim() || sending) return;
    setSending(true); setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const response = await fetch(`/api/company/sessions/${sessionId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSessionId: target, targetRole: role.trim(), body: body.trim(), kind: 'notify', idempotencyKey: key.current }),
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      setBody(''); key.current = null; onSent();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  }
  return <form className="space-y-2 border-b p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
    <p className="text-xs font-medium">Enviar instrução</p>
    <label className="block text-[11px] text-muted-foreground">Sessão destinatária
      <select className="mt-1 h-8 w-full rounded border bg-background px-2 text-xs text-foreground" value={target} disabled={sending} onChange={e => { setTarget(e.target.value); key.current = null; }}>
        {(data?.sessions ?? [{ id: sessionId, name: 'Esta sessão', status: '' }]).map(s => <option key={s.id} value={s.id}>{s.id === companyId ? 'Principal' : s.name} · {s.status}</option>)}
      </select>
    </label>
    <label className="block text-[11px] text-muted-foreground">Papel destinatário
      <input className="mt-1 h-8 w-full rounded border bg-background px-2 text-xs text-foreground" value={role} disabled={sending} onChange={e => { setRole(e.target.value); key.current = null; }} placeholder="master, frontend, qa…" />
    </label>
    <textarea className="min-h-20 w-full resize-y rounded border bg-background p-2 text-xs" aria-label="Instrução ao agente" value={body} disabled={sending} onChange={e => { setBody(e.target.value); key.current = null; }} placeholder="Descreva a instrução e o resultado esperado…" />
    <p className="text-[10px] text-muted-foreground">A mensagem fica na fila da sessão escolhida. Sessões pausadas aguardam retomada.</p>
    {(error || loadError) && <p role="alert" className="text-xs text-destructive">{error || loadError}</p>}
    <Button size="sm" type="submit" disabled={sending || !body.trim() || !role.trim()} className="gap-2"><Send className="size-3" />{sending ? 'Enviando…' : 'Enviar'}</Button>
  </form>;
}

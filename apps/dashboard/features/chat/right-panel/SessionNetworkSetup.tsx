import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPost, apiPut, useApi } from '../../../hooks/useApi.js';
import type { ChatSpawnInput } from '@mcp/api-bus';
import type { NetworkData } from './network-types.js';
import { UltraPolicyStatus } from './UltraPolicyStatus.js';

export function SessionNetworkSetup({ sessionId, data, changed }: { sessionId: string; data: NetworkData; changed: () => void }) {
  const { t } = useTranslation('chat');
  const [members, setMembers] = useState<Array<ChatSpawnInput & { key: string }>>([]);
  const [objective, setObjective] = useState(''), [start, setStart] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const { data: catalog } = useApi<{ providers: Array<{ id: string; name: string; models?: Array<{ id: string; name: string; mode?: string }> }> }>(members.length ? '/coder/providers' : '');
  const config = data.config;
  const projects = data.projects ?? config.projectIds.map(id => ({ id, name: String(id) }));
  const update = async (patch: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await apiPut(`/coder/sessions/${sessionId}/collaboration/settings`, patch); changed(); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const edit = (key: string, patch: Partial<ChatSpawnInput>) => { setMembers(rows => rows.map(row => row.key === key ? { ...row, ...patch } : row)); setRequestId(crypto.randomUUID()); };
  const create = async () => {
    setBusy(true); setError(null);
    try {
      await apiPost(`/coder/sessions/${sessionId}/collaboration/team`, { requestId,
        members: members.map(({ key: _key, ...row }) => ({ ...row, start, prompt: objective ? `${objective}\n\n${row.role}` : row.role })) });
      setMembers([]); setRequestId(crypto.randomUUID()); changed();
      window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <UltraPolicyStatus sessionId={sessionId} />
    <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={event => void update({ enabled: event.target.checked })} />{t('network.mode')}</label>
    <p className="text-muted-foreground">{t('network.modeHint')}</p>
    <div className="grid grid-cols-2 gap-2">
      <label>{t('network.sessionLimit')}<input aria-label={t('network.sessionLimit')} className="mt-1 w-full rounded border bg-background p-1" type="number" min="2" max="32" defaultValue={config.maxSessions} key={`sessions-${config.maxSessions}`} disabled={busy || config.rootId !== sessionId} onBlur={event => { if (+event.target.value !== config.maxSessions) void update({ maxSessions: +event.target.value }); }} /></label>
      <label>{t('network.wakeLimit')}<input aria-label={t('network.wakeLimit')} className="mt-1 w-full rounded border bg-background p-1" type="number" min="1" max="500" defaultValue={config.maxWakeups} key={`wakes-${config.maxWakeups}`} disabled={busy || config.rootId !== sessionId} onBlur={event => { if (+event.target.value !== config.maxWakeups) void update({ maxWakeups: +event.target.value }); }} /></label>
    </div>
    <div className="flex items-center gap-2"><span>{t('network.wakeUsage', { used: data.wakeCount, max: data.rootBudget })}</span>
      {config.rootId === sessionId && <button type="button" disabled={busy} className="text-primary hover:underline" onClick={() => void update({ resetBudget: true })}>{t('network.resetBudget')}</button>}</div>
    <details><summary className="cursor-pointer">{t('network.role')}</summary><textarea aria-label={t('network.role')} className="mt-2 min-h-20 w-full rounded border bg-background p-2" defaultValue={config.role} key={config.role} onBlur={event => { if (event.target.value !== config.role) void update({ role: event.target.value }); }} /></details>
    <p className="text-muted-foreground">{t('network.projectsHint')} {projects.map(project => `$${project.name}`).join(', ')}</p>
    <h3 className="border-t pt-3 font-medium">{t('network.team')}</h3>
    <p className="text-muted-foreground">{t('network.teamHint')}</p>
    {members.map((member, index) => <fieldset key={member.key} disabled={busy} className="space-y-2 rounded border p-2">
      <legend className="px-1">{t('network.member', { index: index + 1 })}</legend>
      <input aria-label={t('network.memberTitle', { index: index + 1 })} placeholder={t('network.title')} className="w-full rounded border bg-background p-1.5" value={member.title} onChange={event => edit(member.key, { title: event.target.value })} />
      <textarea aria-label={t('network.memberRole', { index: index + 1 })} placeholder={t('network.role')} className="min-h-20 w-full rounded border bg-background p-1.5" value={member.role} onChange={event => edit(member.key, { role: event.target.value })} />
      <select aria-label={t('network.memberModel', { index: index + 1 })} className="w-full rounded border bg-background p-1.5" value={member.provider ? JSON.stringify([member.provider, member.model]) : ''} onChange={event => { const [provider, model] = event.target.value ? JSON.parse(event.target.value) : ['', '']; edit(member.key, { provider, model }); }}>
        <option value="">{t('network.inheritModel')}</option>{catalog?.providers?.filter(provider => provider.id).map(provider => <optgroup key={provider.id} label={provider.name}>{provider.models?.map(model => <option key={`${model.id}:${model.mode}`} value={JSON.stringify([provider.id, model.id + (model.mode ? `::${model.mode}` : '')])}>{model.name || model.id}</option>)}</optgroup>)}
      </select>
      <select aria-label={t('network.memberProject', { index: index + 1 })} className="w-full rounded border bg-background p-1.5" value={member.projectId ?? ''} onChange={event => edit(member.key, { projectId: event.target.value ? +event.target.value : undefined })}>
        <option value="">{t('network.sameProject')}</option>{projects.map(project => <option key={project.id} value={project.id}>${project.name}</option>)}
      </select>
      <button type="button" className="text-destructive" onClick={() => { setMembers(rows => rows.filter(row => row.key !== member.key)); setRequestId(crypto.randomUUID()); }}>{t('network.remove')}</button>
    </fieldset>)}
    <button type="button" disabled={busy || !config.enabled || members.length >= config.maxSessions - 1} className="rounded border px-2 py-1 disabled:opacity-40" onClick={() => setMembers(rows => [...rows, { key: crypto.randomUUID(), title: '', role: '' }])}>{t('network.addMember')}</button>
    {members.length > 0 && <>
      <textarea aria-label={t('network.objective')} placeholder={t('network.objective')} className="min-h-16 w-full rounded border bg-background p-2" value={objective} onChange={event => { setObjective(event.target.value); setRequestId(crypto.randomUUID()); }} />
      <label className="flex gap-2"><input type="checkbox" checked={start} onChange={event => { setStart(event.target.checked); setRequestId(crypto.randomUUID()); }} />{t('network.startNow')}</label>
      <button type="button" disabled={busy || !config.enabled || members.some(member => !member.title.trim() || !member.role.trim())} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40" onClick={() => void create()}>{t(start ? 'network.createAndStart' : 'network.prepareTeam')}</button>
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}

import { useRef, useState } from 'react';
import { usePolling } from '../../../hooks/usePolling.js';
import { useTranslation } from 'react-i18next';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import type { TaskProposal, ScheduledTrigger, ScheduledOccurrence } from '@mcp/api-bus';
import { getDraft, setDraft, hydrateFromStorageOnce } from '../composer/composer-draft-store.js';

interface Followups { proposals: TaskProposal[]; schedules: ScheduledTrigger[]; occurrences: ScheduledOccurrence[] }
export function UltraFollowupsPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('chat');
  const base = `/coder/sessions/${sessionId}/collaboration`;
  const { data, error, refetch } = useApi<Followups>(`${base}/followups`);
  const [failure, setFailure] = useState(''), [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState(''), [at, setAt] = useState(''), [cron, setCron] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [action, setAction] = useState('notify'), [misfire, setMisfire] = useState('ask'), [overlap, setOverlap] = useState('skip');
  const [maxRuns, setMaxRuns] = useState(1);
  const attempt = useRef({ payload: '', key: crypto.randomUUID() });
  usePolling(refetch, 5000, { immediate: false });
  const perform = async (run: () => Promise<void>) => {
    setBusy(true); setFailure('');
    try { await run(); refetch(); } catch (e) { setFailure(String(e)); } finally { setBusy(false); }
  };
  const accept = (proposal: TaskProposal, mode: 'here' | 'new') => perform(async () => {
    const result = await apiPost<{ seed: string; sessionId: string }>(`${base}/proposals/${proposal.id}/accept`, { revision: proposal.revision, requestId: `accept:${proposal.id}:${mode}`, mode });
    const draftKey = `coder:${result.sessionId}`;
    hydrateFromStorageOnce(draftKey);
    const draft = getDraft(draftKey);
    setDraft(draftKey, { ...draft, text: draft.text.includes(result.seed) ? draft.text : [draft.text, result.seed].filter(Boolean).join('\n\n') });
    window.dispatchEvent(new CustomEvent(result.sessionId === sessionId ? 'coder:fill-composer' : 'coder:proposal-prepared', { detail: { sessionId: result.sessionId, text: result.seed } }));
  });
  const control = (row: ScheduledTrigger, command: string) => perform(async () => { await apiPost(`${base}/schedules/${row.id}/control`, { revision: row.revision, action: command }); });
  const create = () => perform(async () => {
    const input = { kind: cron.trim() ? 'recurring' : 'once', ...(cron.trim() ? { cron: cron.trim() } : { at: new Date(at).getTime() }), timezone, action, prompt, misfire, overlap, maxRuns };
    const payload = JSON.stringify(input);
    if (attempt.current.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    await apiPost(`${base}/schedules`, { ...input, requestId: attempt.current.key }); setPrompt(''); attempt.current.payload = '';
  });
  return <div className="space-y-4" data-testid="ultra-followups">
    {(error || failure) && <p role="alert" className="text-destructive">{failure || error}</p>}
    <h3 className="font-medium">{t('ultra.proposals')}</h3><p className="text-muted-foreground">{t('ultra.proposalHint')}</p>
    {data?.proposals.filter(row => row.state === 'pending' || row.state === 'claimed').slice(0, 3).map(row => <article key={row.id} className="space-y-2 rounded border p-2">
      <strong>{row.title}</strong><p>{row.rationale}</p><details><summary>{t('ultra.details')}</summary><p className="whitespace-pre-wrap">{row.prompt}</p></details>
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || (row.mode !== undefined && row.mode !== 'here')} className="rounded border px-2 py-1" onClick={() => void accept(row, 'here')}>{t('ultra.here')}</button>
        <button disabled={busy || (row.mode !== undefined && row.mode !== 'new')} className="rounded border px-2 py-1" onClick={() => void accept(row, 'new')}>{t('ultra.newChat')}</button>
        <button disabled={busy || row.state !== 'pending'} onClick={() => void perform(async () => { await apiPost(`${base}/proposals/${row.id}/dismiss`, { revision: row.revision }); })}>{t('ultra.dismiss')}</button>
      </div>
    </article>)}
    {data?.proposals.filter(row => row.state === 'accepted').map(row => <p key={row.id} className="text-muted-foreground">{row.title} · {t('ultra.prepared')}</p>)}
    <h3 className="border-t pt-3 font-medium">{t('ultra.schedules')}</h3><p className="text-muted-foreground">{t('ultra.localHint')}</p>
    {data?.schedules.map(row => <article key={row.id} className="space-y-2 rounded border p-2"><p className="whitespace-pre-wrap">{row.prompt}</p>
      <p>{t(`ultra.state.${row.state}`, row.state)} · {new Date(row.nextDueAt).toLocaleString()} · {row.timezone} · {row.runs}/{row.maxRuns}</p>
      {!['completed', 'cancelled'].includes(row.state) && <div className="flex gap-2"><button disabled={busy} onClick={() => void control(row, row.state === 'active' ? 'pause' : 'resume')}>{t(row.state === 'active' ? 'ultra.pause' : 'ultra.activate')}</button><button disabled={busy} className="text-destructive" onClick={() => void control(row, 'cancel')}>{t('ultra.cancel')}</button></div>}
      {row.state === 'completed' && data.occurrences.some(occurrence => occurrence.scheduleId === row.id && ['due', 'claimed', 'accepted'].includes(occurrence.state))
        && <button disabled={busy} className="text-destructive" onClick={() => void control(row, 'cancel')}>{t('ultra.cancel')}</button>}
    </article>)}
    <details><summary>{t('ultra.createSchedule')}</summary><fieldset disabled={busy} className="mt-2 space-y-2">
      <label className="block">{t('ultra.task')}<textarea className="w-full rounded border bg-background p-2" value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      <label className="block">{t('ultra.at')}<input className="w-full rounded border bg-background p-1" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></label>
      <label className="block">{t('ultra.cron')}<input className="w-full rounded border bg-background p-1" value={cron} onChange={e => setCron(e.target.value)} placeholder="0 9 * * 1-5" /></label>
      <label className="block">{t('ultra.timezone')}<input className="w-full rounded border bg-background p-1" value={timezone} onChange={e => setTimezone(e.target.value)} /></label>
      {([{ key: 'action', value: action, set: setAction, values: ['notify', 'resume', 'run'] }, { key: 'misfire', value: misfire, set: setMisfire, values: ['skip', 'fire_once', 'ask'] }, { key: 'overlap', value: overlap, set: setOverlap, values: ['skip', 'coalesce'] }]).map(field => <label key={field.key} className="block">{t(`ultra.${field.key}`)}<select className="w-full rounded border bg-background p-1" value={field.value} onChange={e => field.set(e.target.value)}>{field.values.map(value => <option key={value} value={value}>{t(`ultra.${field.key}.${value}`)}</option>)}</select></label>)}
      <label className="block">{t('ultra.maxRuns')}<input className="w-full rounded border bg-background p-1" type="number" min="1" max="100" value={maxRuns} onChange={e => setMaxRuns(+e.target.value)} /></label>
      <button className="rounded bg-primary px-3 py-1.5 text-primary-foreground" disabled={!prompt.trim() || (!at && !cron.trim())} onClick={() => void create()}>{t('ultra.createSchedule')}</button>
    </fieldset></details>
    <h3 className="font-medium">{t('ultra.occurrences')}</h3>
    {data?.occurrences.slice(0, 20).map(row => <p key={row.id}>{new Date(row.dueAt).toLocaleString()} · {t(`ultra.state.${row.state}`, row.state)}{row.detail && ` · ${row.detail}`}</p>)}
  </div>;
}

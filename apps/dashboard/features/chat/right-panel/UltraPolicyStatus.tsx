import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPatch, useApi } from '../../../hooks/useApi.js';
import type { ChatNetworkPolicySnapshot } from '@mcp/api-bus';
import { isNetworkPolicySnapshot } from './network-payload.js';

export function UltraPolicyStatus({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('chat');
  const path = `/coder/sessions/${sessionId}/collaboration/policy`;
  const { data, refetch, error } = useApi<ChatNetworkPolicySnapshot>(path);
  const [failure, setFailure] = useState('');
  if (!data) return error ? <p role="alert">{error}</p> : null;
  if (!isNetworkPolicySnapshot(data)) return <div role="alert">{t('collaboration.invalidResponse')}
    <button className="ml-2 underline" onClick={refetch}>{t('messages.retry')}</button></div>;
  const policy = data.policy;
  return <div className="space-y-2 rounded border p-2">
    <strong>Ultra {policy?.presetVersion ?? 'v3'}</strong>
    {policy && <p>{t('ultra.effective', { count: policy.effective.parallelism.maxAgents, effort: policy.effective.reasoning.effort ?? policy.effective.reasoning.mode })}</p>}
    {policy?.reasons.map((reason, index) => <p key={index} className="text-muted-foreground">{reason.code}: {reason.requested ?? '—'} → {reason.effective ?? '—'}</p>)}
    <label className="block">{t('ultra.parallelNext')}<select className="ml-2 rounded border bg-background" value={data.settings.maxParallel ?? 3} onChange={event => {
      void apiPatch(path, { maxParallel: +event.target.value, expectedRevision: data.revision }).then(refetch).catch(e => setFailure(String(e)));
    }}>{[1, 2, 3].map(value => <option key={value}>{value}</option>)}</select></label>
    {data.isBudgetRoot && <label className="block">{t('ultra.maxStarts')}<input key={data.revision} className="ml-2 w-16 rounded border bg-background" type="number" min="1" max="100" defaultValue={data.settings.maxStarts ?? 24} onBlur={event => {
      const value = Number(event.target.value); if (value === (data.settings.maxStarts ?? 24)) return;
      void apiPatch(path, { maxStarts: value, expectedRevision: data.revision }).then(refetch).catch(e => setFailure(String(e)));
    }} /></label>}
    <p>{t('ultra.budget', { used: data.budget.starts, max: data.budget.limits.maxStarts, active: data.budget.active, tokens: data.budget.tokens })}</p>
    <p>{t('ultra.cost')}: {data.budget.costUsd === null ? t('ultra.unknownCost') : `$${data.budget.costUsd.toFixed(4)}`}</p>
    {data.budget.uncertain > 0 && <p className="text-amber-600">{t('ultra.uncertain', { count: data.budget.uncertain })}</p>}
    {failure && <p role="alert" className="text-destructive">{failure}</p>}
  </div>;
}

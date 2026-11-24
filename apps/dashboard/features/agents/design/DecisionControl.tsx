import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DecisionMode } from '@mcp/company-contracts/designer.js';
import { apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import { Button } from '../../../components/ui/button.js';

type Policy = {
  own: DecisionMode;
  enabled: boolean;
  effective: DecisionMode;
  origin: string;
  calibrating?: boolean;
  fixedProfile?: string | null;
};
export function DecisionControl({
  kind,
  id,
  text,
  cardId,
  baseline,
  onChoose,
}: {
  kind: 'chat' | 'company';
  id: string;
  text: string;
  cardId?: string;
  baseline?: string;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation('agents');
  const route = '/decisions/' + kind + '/' + id;
  const policy = useApi<Policy>(route);
  useEffect(() => {
    const changed = () => policy.refetch();
    window.addEventListener('clef:settings', changed);
    return () => window.removeEventListener('clef:settings', changed);
  }, [policy.refetch]);
  useEffect(() => {
    if (kind === 'chat' && baseline) policy.refetch();
  }, [kind, baseline, policy.refetch]);
  const [result, setResult] = useState<{
    candidate: string | null;
    sampleId?: string;
    reason: string;
    options?: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const terms = text.trim().slice(0, 1200);
  useEffect(() => {
    setResult(null);
    setBusy(false);
    setError('');
    return () => {
      epoch.current++;
    };
  }, [terms, route, baseline, cardId, policy.data?.effective]);
  useEffect(() => {
    if (policy.data?.effective !== 'shadow' || policy.data.fixedProfile) return;
    const evaluate = (excerpt: string) => {
      if (excerpt)
        void apiPost(
          route + '/suggest',
          { text: excerpt.slice(0, 1200), cardId, source: 'sample' },
          undefined,
          { invalidateReads: false },
        ).catch(() => {});
    };
    if (kind === 'company' && cardId) {
      evaluate(terms);
      return;
    }
    if (kind !== 'chat') return;
    const sent = (event: Event) => {
      const data = (event as CustomEvent<{ id: string; text: string }>).detail;
      if (data?.id === id) evaluate(data.text);
    };
    window.addEventListener('clef:chat-sent', sent);
    return () => window.removeEventListener('clef:chat-sent', sent);
  }, [
    policy.data?.effective,
    policy.data?.fixedProfile,
    route,
    kind,
    id,
    cardId,
    kind === 'company' ? terms : '',
  ]);
  if (!policy.data?.enabled) return null;
  async function suggest() {
    const ticket = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const next = await apiPost<NonNullable<typeof result>>(
        route + '/suggest',
        { text: terms, cardId },
        undefined,
        { invalidateReads: false },
      );
      if (ticket === epoch.current) setResult(next);
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }
  function select(choice: string | null) {
    if (result?.sampleId)
      void apiPost(route + '/feedback', { sampleId: result.sampleId, choice }, undefined, {
        invalidateReads: false,
      }).catch(() => {});
    setResult(null);
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t('designer.clef')}</summary>
      <div className="my-1 flex flex-wrap items-center gap-2 rounded border p-2">
        <select
          className="rounded border bg-background p-1"
          aria-label={t('designer.policy')}
          value={policy.data.own}
          onChange={(e) => {
            epoch.current++;
            setResult(null);
            void apiPatch(route, { mode: e.target.value })
              .then(policy.refetch)
              .catch((e) => setError(e.message));
          }}
        >
          {(['inherit', 'off', 'shadow', 'suggest'] as const).map((v) => (
            <option key={v} value={v}>
              {t('designer.' + v)}
            </option>
          ))}
        </select>
        <span>
          {t('designer.effective')} · {t('designer.' + policy.data.effective)} (
          {t('designer.' + policy.data.origin)})
        </span>
        {policy.data.effective !== 'off' && (cardId || kind === 'chat') && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !terms || !!policy.data.fixedProfile || (!cardId && kind === 'company')}
            onClick={() => void suggest()}
          >
            {t(
              policy.data.effective === 'shadow'
                ? 'designer.evaluate'
                : kind === 'chat'
                  ? 'designer.suggestProfile'
                  : 'designer.suggestOwner',
            )}
          </Button>
        )}
        {policy.data.calibrating && <span>{t('designer.calibrating')}</span>}
        {policy.data.fixedProfile && (
          <span>{t('designer.fixedProfile', { profile: policy.data.fixedProfile })}</span>
        )}
        {result?.candidate ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              const id = result.candidate!;
              select(id);
              onChoose(id);
            }}
          >
            {t('designer.use')} · {result.candidate}
          </Button>
        ) : (
          result && <span role="status">{t('designer.nosuggestion')}</span>
        )}
        {result?.options && (
          <label>
            {t('designer.yourChoice')}{' '}
            <select
              className="rounded border bg-background"
              defaultValue=""
              onChange={(e) => select(e.target.value === '__none' ? null : e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {result.options.map((id) => (
                <option key={id}>{id}</option>
              ))}
              <option value="__none">{t('designer.none')}</option>
            </select>
          </label>
        )}
        {error && <span role="alert">{error}</span>}
      </div>
    </details>
  );
}
type Global = {
  settings: { enabled: boolean; defaultMode: DecisionMode; provider: string; dailyLimit: number };
  estimate?: { usd: number; usdPerMillion: number; unmetered: number };
  quality?: Record<
    'company' | 'chat',
    {
      labeled: number;
      coverage: number;
      accuracy: number;
      pilot: { labeled: number; coverage: number; accuracy: number };
      canSuggest: boolean;
      basis: 'pilot' | 'installation';
    }
  >;
  providers: { id: string; name: string }[];
  usage: { requests: number; tokens: number; accepted: number; corrected: number; abstained: number };
};
export function DecisionSettingsPanel() {
  const { t } = useTranslation('agents');
  const { data, refetch } = useApi<Global>('/admin/clef');
  const [form, setForm] = useState<Global['settings'] | null>(null);
  const [error, setError] = useState('');
  const values = form ?? data?.settings;
  if (!values || !data) return null;
  return (
    <section className="m-3 space-y-2 rounded border p-3 text-sm">
      <h3 className="font-semibold">{t('designer.clef')}</h3>
      <p className="text-xs text-muted-foreground">{t('designer.cloudInfo')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <input
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => setForm({ ...values, enabled: e.target.checked })}
          />{' '}
          {t('designer.enabled')}
        </label>
        <label>
          {t('designer.provider')}{' '}
          <select
            className="rounded border bg-background"
            value={values.provider}
            onChange={(e) => setForm({ ...values, provider: e.target.value })}
          >
            <option value="">—</option>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('designer.defaultMode')}{' '}
          <select
            className="rounded border bg-background"
            value={values.defaultMode}
            onChange={(e) => setForm({ ...values, defaultMode: e.target.value as DecisionMode })}
          >
            {['off', 'shadow', 'suggest'].map((v) => (
              <option value={v} key={v}>
                {t('designer.' + v)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('designer.dailyLimit')}{' '}
          <input
            className="w-16 rounded border bg-background"
            type="number"
            min={0}
            max={10000}
            value={values.dailyLimit}
            onChange={(e) => setForm({ ...values, dailyLimit: Number(e.target.value) })}
          />
        </label>
        <Button
          size="sm"
          disabled={!form}
          onClick={() => {
            void apiPatch('/admin/clef', values)
              .then(() => {
                setForm(null);
                setError('');
                refetch();
                window.dispatchEvent(new Event('clef:settings'));
              })
              .catch((e) => setError(e.message));
          }}
        >
          {t('designer.save')}
        </Button>
      </div>
      <p className="text-xs">
        {t('designer.usage', {
          requests: data.usage.requests,
          tokens: data.usage.tokens,
          accepted: data.usage.accepted,
          corrected: data.usage.corrected,
        })}
      </p>
      {data.estimate && (
        <p className="text-xs">
          {t('designer.costEstimate', {
            amount: data.estimate.usd.toFixed(6),
            rate: data.estimate.usdPerMillion,
            unknown: data.estimate.unmetered,
          })}
        </p>
      )}
      {data.quality &&
        (['company', 'chat'] as const).map((kind) => (
          <p className="text-xs" key={kind}>
            <strong>{t('designer.' + kind)}</strong> ·{' '}
            {t(data.quality![kind].canSuggest ? 'designer.suggestionAvailable' : 'designer.shadow')}
            <br />
            {t('designer.pilot')} ·{' '}
            {t('designer.quality', {
              total: data.quality![kind].pilot.labeled,
              coverage: Math.round(data.quality![kind].pilot.coverage * 100),
              accuracy: Math.round(data.quality![kind].pilot.accuracy * 100),
            })}
            <br />
            {t('designer.installation')} ·{' '}
            {t('designer.quality', {
              total: data.quality![kind].labeled,
              coverage: Math.round(data.quality![kind].coverage * 100),
              accuracy: Math.round(data.quality![kind].accuracy * 100),
            })}
          </p>
        ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

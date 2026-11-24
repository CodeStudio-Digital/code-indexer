import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  designPlan,
  type DesignDraft,
  type DesignPlan,
  type DesignProposal,
  type DesignSection,
} from '@mcp/company-contracts/designer.js';
import { useProviders } from '../../../hooks/useProviders.js';
import { apiPatch, apiPost, useApi } from '../../../hooks/useApi.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { fieldClass, ModelSelect, PlanEditor } from './PlanEditor.js';

interface Props {
  sourceId?: string;
  onClose: () => void;
  onApplied: (id: string) => void;
}
export function CompanyDesigner({ sourceId, onClose, onApplied }: Props) {
  const { t } = useTranslation('agents');
  const providers = useProviders();
  const catalog = useApi<{ id: string; name: string; sourceId: string | null }[]>('/company/drafts');
  const [draft, setDraft] = useState<DesignDraft | null>(null);
  const [local, setLocal] = useState<{ plan: DesignPlan; pins: string[] } | null>(null);
  const ref = useRef(draft);
  const edits = useRef(local);
  const queue = useRef(Promise.resolve());
  const [target, setTarget] = useState({ provider: '', model: '' });
  const targetRef = useRef(target);
  targetRef.current = target;
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState<DesignProposal | null>(null);
  const [chosen, setChosen] = useState<DesignSection[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [review, setReview] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [undo, setUndo] = useState<DesignPlan | null>(null);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!providers.loading && !target.provider && providers.enrichedProviders.length) {
      const p = providers.enrichedProviders[0].id;
      setTarget({ provider: p, model: providers.getDefaultModel(p) });
    }
  }, [providers.loading, providers.enrichedProviders, target.provider]);
  function acceptDraft(d: DesignDraft) {
    if (d.advisor?.provider) {
      targetRef.current = d.advisor;
      setTarget(d.advisor);
    }
    ref.current = d;
    setDraft(d);
    edits.current = { plan: d.plan, pins: d.pins };
    setLocal(edits.current);
  }
  const remember = (d: DesignDraft) => {
    ref.current = d;
    if (mounted.current) setDraft(d);
  };
  function save() {
    const operation = queue.current.then(async () => {
      const d = ref.current;
      const data = edits.current;
      if (!d || !data || d.apply) return;
      const normalized = designPlan.parse(data.plan);
      const changes = Object.fromEntries(
        Object.entries(normalized).filter(
          ([k, v]) => JSON.stringify(v) !== JSON.stringify(d.plan[k as DesignSection]),
        ),
      );
      const advisor = targetRef.current;
      if (
        !Object.keys(changes).length &&
        JSON.stringify(data.pins) === JSON.stringify(d.pins) &&
        advisor.provider === (d.advisor?.provider ?? '') &&
        advisor.model === (d.advisor?.model ?? '')
      )
        return;
      remember(
        await apiPatch<DesignDraft>('/company/drafts/' + d.id, {
          expectedRevision: d.revision,
          changes,
          pins: data.pins,
          advisor,
        }),
      );
    });
    queue.current = operation.catch(() => {});
    return operation;
  }
  useEffect(() => {
    if (!local || !draft || draft.apply || busy) return;
    const timer = setTimeout(() => {
      void save().catch((e) => setError(e.message));
    }, 700);
    return () => clearTimeout(timer);
  }, [local, draft, busy, target]);
  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (err) {
      if (mounted.current && !abort.current?.signal.aborted) setError((err as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  function edit<K extends DesignSection>(key: K, value: DesignPlan[K], paths: string[] = [key]) {
    if (!edits.current) return;
    const next = {
      plan: { ...edits.current.plan, [key]: value },
      pins: [...new Set([...edits.current.pins, ...paths])],
    };
    edits.current = next;
    setLocal(next);
    setReview(false);
  }
  async function open(id?: string) {
    if (id) {
      const response = await fetch('/api/company/drafts/' + id);
      if (!response.ok) throw Error('HTTP ' + response.status);
      acceptDraft(await response.json());
    } else acceptDraft(await apiPost<DesignDraft>('/company/drafts', { sourceId, ...target }));
    setProposal(null);
    setUndo(null);
    setReview(false);
  }
  async function ask() {
    await save();
    const d = ref.current!;
    const controller = new AbortController();
    abort.current = controller;
    try {
      const suggestion = await apiPost<DesignProposal>(
        '/company/drafts/' + d.id + '/proposals',
        { expectedRevision: d.revision, request, ...target },
        controller.signal,
        { invalidateReads: false },
      );
      if (controller.signal.aborted) return;
      setProposal(suggestion);
      setChosen(Object.keys(suggestion.changes) as DesignSection[]);
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }
  async function accept() {
    if (!proposal) return;
    await save();
    const d = ref.current!;
    if (d.revision !== proposal.baseRevision) throw Error(t('designer.stale'));
    const changes = Object.fromEntries(
      chosen.filter((k) => !d.pins.includes(k)).map((k) => [k, proposal.changes[k]]),
    );
    const next = await apiPatch<DesignDraft>('/company/drafts/' + d.id, {
      expectedRevision: d.revision,
      changes,
      turn: { request: proposal.request, reply: proposal.reply },
    });
    setUndo(d.plan);
    acceptDraft(next);
    setRequest('');
    setProposal(null);
  }
  async function apply() {
    await save();
    const d = ref.current!;
    const result = d.apply?.done
      ? d
      : await apiPost<DesignDraft>('/company/drafts/' + d.id + '/apply', {
          expectedRevision: d.revision,
          key: d.apply?.key ?? d.id,
        });
    acceptDraft(result);
    if (saveTemplate) {
      await apiPost('/company/drafts/' + result.id + '/template', {});
    }
    onApplied(result.apply!.companyId);
  }
  const { data: projects } = useApi<{ id: number; name: string }[]>('/projects');
  const projectNames = new Map(projects?.map((p) => [p.id, p.name]));
  function describeSection(key: DesignSection, plan: DesignPlan) {
    if (key === 'roles')
      return plan.roles
        .map((r) =>
          [
            r.role,
            r.provider + ' / ' + r.model,
            r.effort,
            r.responsibility,
            r.skills.join(', '),
            r.projectIds.map((id) => projectNames.get(id) ?? id).join(', '),
            r.readOnly ? t('designer.readOnly') : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
        .join('\n');
    if (key === 'tasks')
      return plan.tasks
        .map((task) =>
          [
            task.title,
            task.owner,
            projectNames.get(task.projectId ?? 0),
            task.description,
            ...task.criteria,
            task.dependsOn.join(', '),
          ]
            .filter(Boolean)
            .join(' · '),
        )
        .join('\n');
    if (key === 'projectIds') return plan.projectIds.map((id) => projectNames.get(id) ?? id).join(', ');
    if (key === 'visualQA') return plan.visualQA ? '✓' : '—';
    return String(plan[key] ?? '');
  }
  const existing = catalog.data?.filter((d) => d.sourceId === (sourceId ?? null)) ?? [];
  const close = () => {
    if (busy === 'ask') abort.current?.abort();
    void act('save', async () => {
      await save();
      onClose();
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!busy || busy === 'ask')) close();
      }}
    >
      <DialogContent className="flex max-h-[88vh] w-[94vw] max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t(sourceId ? 'designer.adjust' : 'designer.create')}</DialogTitle>
        </DialogHeader>
        {error && (
          <div role="alert" className="rounded border border-destructive/50 p-2 text-sm">
            {error}
            {draft && (
              <Button size="sm" variant="ghost" onClick={() => void act('load', () => open(draft.id))}>
                {t('designer.reload')}
              </Button>
            )}
          </div>
        )}
        {!draft || !local ? (
          <div className="space-y-3">
            <Button disabled={!!busy || providers.loading} onClick={() => void act('open', () => open())}>
              {t('designer.startDraft')}
            </Button>
            {existing.map((d) => (
              <Button
                key={d.id}
                variant="outline"
                disabled={!!busy}
                onClick={() => void act('open', () => open(d.id))}
              >
                {t('designer.resume')} · {d.name || d.id.slice(0, 8)}
              </Button>
            ))}
          </div>
        ) : (
          <>
            <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-2">
              <div className="space-y-3 md:overflow-auto md:pr-2">
                <label className="text-xs">{t('designer.designerModel')}</label>
                <ModelSelect
                  {...target}
                  providers={providers}
                  update={(provider, model) => setTarget({ provider, model })}
                />
                {draft.history.map((turn, i) => (
                  <div key={i} className="space-y-1 border-l-2 pl-2 text-sm">
                    <p className="font-medium">{turn.request}</p>
                    <p className="whitespace-pre-wrap">{turn.reply}</p>
                  </div>
                ))}
                <label className="block text-sm">
                  {t('designer.ask')}
                  <textarea
                    className={fieldClass + ' min-h-20'}
                    value={request}
                    onChange={(e) => setRequest(e.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!!busy || !request.trim() || !target.model || !!draft.apply}
                  onClick={() => void act('ask', ask)}
                >
                  {t('designer.propose')}
                </Button>
                {busy === 'ask' && (
                  <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                    {t('designer.cancel')}
                  </Button>
                )}
                {proposal && (
                  <section className="space-y-2 rounded border p-3">
                    <p className="whitespace-pre-wrap text-sm">{proposal.reply}</p>
                    {(Object.keys(proposal.changes) as DesignSection[]).map((k) => (
                      <div key={k}>
                        <label className="text-xs">
                          <input
                            type="checkbox"
                            checked={chosen.includes(k)}
                            onChange={(e) =>
                              setChosen(e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k))
                            }
                          />{' '}
                          {t('designer.fields.' + k)}
                        </label>
                        <dl className="max-h-36 overflow-auto whitespace-pre-wrap text-xs">
                          <dt className="text-muted-foreground">{t('designer.before')}</dt>
                          <dd>{describeSection(k, local.plan) || '—'}</dd>
                          <dt className="mt-1 text-muted-foreground">{t('designer.after')}</dt>
                          <dd>{describeSection(k, { ...local.plan, ...proposal.changes }) || '—'}</dd>
                        </dl>
                      </div>
                    ))}
                    <Button disabled={!!busy} onClick={() => void act('save', accept)}>
                      {t('designer.accept')}
                    </Button>
                  </section>
                )}
                {local.pins.length > 0 && (
                  <div className="text-xs">
                    {t('designer.pinned')}{' '}
                    {local.pins.map((k) => (
                      <Button
                        key={k}
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => {
                          const next = { ...local, pins: local.pins.filter((p) => p !== k) };
                          edits.current = next;
                          setLocal(next);
                        }}
                      >
                        {[t('designer.fields.' + k.split(':')[0]), ...k.split(':').slice(1)].join(' · ')} ×
                      </Button>
                    ))}
                  </div>
                )}
                {undo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => {
                      const next = { ...local, plan: undo };
                      edits.current = next;
                      setLocal(next);
                      setUndo(null);
                    }}
                  >
                    {t('designer.undo')}
                  </Button>
                )}
              </div>
              <fieldset
                disabled={!!draft.apply || (!!busy && busy !== 'ask')}
                className="min-w-0 md:overflow-auto md:border-l md:pl-4"
              >
                <PlanEditor plan={local.plan} providers={providers} change={edit} />
              </fieldset>
            </div>
            {(review || draft.apply) && (
              <section className="max-h-44 overflow-auto rounded border p-3 text-xs">
                <strong>{local.plan.name}</strong> ·{' '}
                {local.plan.projectIds.map((id) => projectNames.get(id) ?? id).join(', ')}
                {local.plan.roles.map((r) => (
                  <p key={r.role}>
                    {r.role} · {r.provider} / {r.model} {r.effort} · {r.responsibility} {r.skills.join(', ')}
                  </p>
                ))}
                {local.plan.tasks.map((row) => (
                  <p key={row.id}>
                    {row.title} → {row.owner || '—'} · {projectNames.get(row.projectId ?? 0)} ·{' '}
                    {row.criteria.join(' · ')}{' '}
                    {row.dependsOn.length > 0 &&
                      '← ' +
                        row.dependsOn
                          .map((id) => local.plan.tasks.find((t) => t.id === id)?.title ?? id)
                          .join(', ')}
                  </p>
                ))}
                {local.plan.concurrency && (
                  <p>
                    {t('designer.concurrency')} · {local.plan.concurrency}
                  </p>
                )}
                {local.plan.rules && <p>{local.plan.rules}</p>}
                <label>
                  <input
                    type="checkbox"
                    checked={saveTemplate}
                    onChange={(e) => setSaveTemplate(e.target.checked)}
                  />{' '}
                  {t('designer.saveTemplate')}
                </label>
              </section>
            )}
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" disabled={!!busy} onClick={close}>
                {t('designer.close')}
              </Button>
              {review || draft.apply ? (
                <Button disabled={!!busy} onClick={() => void act('apply', apply)}>
                  {t(
                    draft.apply?.done
                      ? saveTemplate
                        ? 'designer.retryTemplate'
                        : 'designer.openCompany'
                      : sourceId
                        ? 'designer.apply'
                        : 'designer.createCompany',
                  )}
                </Button>
              ) : (
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void act('save', async () => {
                      await save();
                      setReview(true);
                    })
                  }
                >
                  {t('designer.review')}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

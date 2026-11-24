import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  newRole,
  type DesignPlan,
  type DesignSection,
  type DesignRole,
  type DesignTask,
} from '@mcp/company-contracts/designer.js';
import type { UseProvidersResult } from '../../../hooks/useProviders.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import { Button } from '../../../components/ui/button.js';

export const fieldClass = 'w-full min-w-0 rounded border bg-background px-2 py-1.5 text-xs';
export function ModelSelect({
  provider,
  model,
  providers,
  update,
}: {
  provider: string;
  model: string;
  providers: UseProvidersResult;
  update: (p: string, m: string) => void;
}) {
  const { t } = useTranslation('agents');
  const all = providers.getModelsForProvider(provider);
  return (
    <div className="grid grid-cols-2 gap-2">
      <select
        className={fieldClass}
        aria-label={t('designer.provider')}
        value={provider}
        onChange={(e) => update(e.target.value, providers.getDefaultModel(e.target.value))}
      >
        <option value="">—</option>
        {providers.providerOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        className={fieldClass}
        aria-label={t('designer.model')}
        value={model}
        onChange={(e) => update(provider, e.target.value)}
      >
        <option value="">—</option>
        {all.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name || m.id}
          </option>
        ))}
      </select>
    </div>
  );
}
type Props = {
  plan: DesignPlan;
  providers: UseProvidersResult;
  change: <K extends DesignSection>(key: K, value: DesignPlan[K], pins?: string[]) => void;
};
export function PlanEditor({ plan, providers, change }: Props) {
  const { t } = useTranslation('agents');
  const [tab, setTab] = useState<'projects' | 'team' | 'tasks' | 'rules'>('projects');
  const { data: projects } = useApi<{ id: number; name: string; root_path: string }[]>('/projects');
  const [query, setQuery] = useState('');
  const [skillQuery, setSkillQuery] = useState('');
  const [skills, setSkills] = useState<{ id: string; name: string }[]>([]);
  const projectKey = plan.projectIds.join(',');
  useEffect(() => {
    if (tab !== 'team') return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void apiPost<typeof skills>(
        '/company/drafts/skills',
        { projectIds: projectKey ? projectKey.split(',').map(Number) : [], query: skillQuery },
        abort.signal,
        { invalidateReads: false },
      )
        .then((rows) => {
          if (!abort.signal.aborted) setSkills(rows);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [projectKey, skillQuery, tab]);
  const bound = (projects ?? []).filter((p) => plan.projectIds.includes(p.id));
  function editRole(index: number, patch: Partial<DesignRole>) {
    const id = plan.roles[index].role;
    const paths =
      patch.role !== undefined
        ? [id, patch.role].filter(Boolean).map((key) => 'roles:' + key)
        : Object.keys(patch).map((field) => 'roles:' + id + ':' + field);
    change(
      'roles',
      plan.roles.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      paths,
    );
  }
  const editTask = (index: number, patch: Partial<DesignTask>) =>
    change(
      'tasks',
      plan.tasks.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      Object.keys(patch).map((field) => 'tasks:' + plan.tasks[index].id + ':' + field),
    );
  function addRole() {
    let index = plan.roles.length + 1;
    while (plan.roles.some((r) => r.role === 'agent-' + index)) index++;
    const role = newRole('agent-' + index, plan.roles[0]?.provider, plan.roles[0]?.model);
    change('roles', [...plan.roles, role], ['roles:' + role.role]);
  }
  function addTask() {
    const id = 'task-' + crypto.randomUUID().slice(0, 8);
    change(
      'tasks',
      [
        ...plan.tasks,
        {
          id,
          title: t('designer.newTask'),
          description: '',
          owner: '',
          projectId: null,
          criteria: [],
          dependsOn: [],
        },
      ],
      ['tasks:' + id],
    );
  }
  return (
    <section className="min-w-0 space-y-3">
      <label className="block text-xs">
        {t('designer.name')}
        <input className={fieldClass} value={plan.name} onChange={(e) => change('name', e.target.value)} />
      </label>
      <nav className="flex flex-wrap gap-1" aria-label={t('designer.plan')}>
        {(['projects', 'team', 'tasks', 'rules'] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={tab === item ? 'secondary' : 'ghost'}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >
            {t('designer.' + item)}
          </Button>
        ))}
      </nav>
      {tab === 'projects' && (
        <>
          <input
            className={fieldClass}
            placeholder={t('designer.findProject')}
            aria-label={t('designer.findProject')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="max-h-64 overflow-auto space-y-1">
            {(projects ?? [])
              .filter((p) => (p.name + ' ' + p.root_path).toLowerCase().includes(query.toLowerCase()))
              .map((p) => (
                <label key={p.id} className="flex items-start gap-2 rounded p-1 hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={plan.projectIds.includes(p.id)}
                    onChange={(e) =>
                      change(
                        'projectIds',
                        e.target.checked
                          ? [...plan.projectIds, p.id]
                          : plan.projectIds.filter((id) => id !== p.id),
                      )
                    }
                  />
                  <span className="min-w-0 text-xs">
                    {p.name}
                    <small className="block truncate text-muted-foreground">{p.root_path}</small>
                  </span>
                </label>
              ))}
          </div>
          <label className="block text-xs">
            {t('designer.goal')}
            <textarea
              className={fieldClass}
              value={plan.goal}
              onChange={(e) => change('goal', e.target.value)}
            />
          </label>
        </>
      )}
      {tab === 'team' && (
        <>
          <label className="block text-xs">
            {t('designer.findSkill')}
            <input
              className={fieldClass}
              value={skillQuery}
              onChange={(e) => setSkillQuery(e.target.value)}
            />
          </label>
          {plan.roles.map((r, i) => (
            <fieldset key={i} className="space-y-2 rounded border p-3">
              <legend className="px-1 text-sm font-semibold">{r.role || t('designer.role')}</legend>
              <label className="block text-xs">
                {t('designer.role')}
                <input
                  className={fieldClass}
                  disabled={r.role === 'master'}
                  value={r.role}
                  onChange={(e) => editRole(i, { role: e.target.value })}
                />
              </label>
              <label className="block text-xs">
                {t('designer.responsibility')}
                <textarea
                  className={fieldClass}
                  value={r.responsibility}
                  onChange={(e) => editRole(i, { responsibility: e.target.value })}
                />
              </label>
              <ModelSelect
                provider={r.provider}
                model={r.model}
                providers={providers}
                update={(provider, model) => editRole(i, { provider, model, effort: '' })}
              />
              <label className="block text-xs">
                {t('designer.effort')}
                <select
                  className={fieldClass}
                  value={r.effort}
                  onChange={(e) => editRole(i, { effort: e.target.value })}
                >
                  <option value="">Auto</option>
                  {(
                    providers.getModelsForProvider(r.provider).find((m) => m.id === r.model)
                      ?.supported_reasoning_levels ?? []
                  ).map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                {t('designer.projects')}
                <select
                  className={fieldClass}
                  multiple
                  value={r.projectIds.map(String)}
                  onChange={(e) =>
                    editRole(i, { projectIds: Array.from(e.target.selectedOptions, (o) => Number(o.value)) })
                  }
                >
                  {bound.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                Skills
                <select
                  className={fieldClass}
                  multiple
                  value={r.skills}
                  onChange={(e) =>
                    editRole(i, { skills: Array.from(e.target.selectedOptions, (o) => o.value) })
                  }
                >
                  {[
                    ...new Map(
                      [...r.skills.map((id) => ({ id, name: id })), ...skills].map((s) => [s.id, s]),
                    ).values(),
                  ].map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {r.role !== 'master' && (
                <div className="flex items-center justify-between">
                  <label className="text-xs">
                    <input
                      type="checkbox"
                      checked={r.readOnly}
                      onChange={(e) => editRole(i, { readOnly: e.target.checked })}
                    />{' '}
                    {t('designer.readOnly')}
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      change(
                        'roles',
                        plan.roles.filter((_, n) => n !== i),
                        ['roles:' + r.role],
                      )
                    }
                  >
                    {t('designer.remove')}
                  </Button>
                </div>
              )}
            </fieldset>
          ))}
          <Button variant="outline" size="sm" onClick={addRole}>
            {t('designer.addRole')}
          </Button>
        </>
      )}
      {tab === 'tasks' && (
        <>
          {plan.tasks.map((task, i) => (
            <fieldset key={task.id} className="space-y-2 rounded border p-3">
              <legend className="px-1">{task.id}</legend>
              <label className="block text-xs">
                {t('designer.deliverable')}
                <input
                  className={fieldClass}
                  value={task.title}
                  onChange={(e) => editTask(i, { title: e.target.value })}
                />
              </label>
              <label className="block text-xs">
                {t('designer.description')}
                <textarea
                  className={fieldClass}
                  value={task.description}
                  onChange={(e) => editTask(i, { description: e.target.value })}
                />
              </label>
              <label className="block text-xs">
                {t('designer.owner')}
                <select
                  className={fieldClass}
                  value={task.owner}
                  onChange={(e) => editTask(i, { owner: e.target.value })}
                >
                  <option value="">—</option>
                  {plan.roles
                    .filter((r) => r.role !== 'master')
                    .map((r) => (
                      <option key={r.role}>{r.role}</option>
                    ))}
                </select>
              </label>
              <label className="block text-xs">
                {t('designer.projects')}
                <select
                  className={fieldClass}
                  value={task.projectId ?? ''}
                  onChange={(e) => editTask(i, { projectId: Number(e.target.value) || null })}
                >
                  <option value="">—</option>
                  {bound.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                {t('designer.criteria')}
                <textarea
                  className={fieldClass}
                  value={task.criteria.join('\n')}
                  onChange={(e) => editTask(i, { criteria: e.target.value.split('\n') })}
                />
              </label>
              <label className="block text-xs">
                {t('designer.depends')}
                <select
                  className={fieldClass}
                  multiple
                  value={task.dependsOn}
                  onChange={(e) =>
                    editTask(i, { dependsOn: Array.from(e.target.selectedOptions, (o) => o.value) })
                  }
                >
                  {plan.tasks
                    .filter((o) => o.id !== task.id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.title}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  change(
                    'tasks',
                    plan.tasks
                      .filter((row) => row.id !== task.id)
                      .map((row) => ({ ...row, dependsOn: row.dependsOn.filter((id) => id !== task.id) })),
                    ['tasks:' + task.id],
                  )
                }
              >
                {t('designer.remove')}
              </Button>
            </fieldset>
          ))}
          <Button size="sm" variant="outline" onClick={addTask}>
            {t('designer.addTask')}
          </Button>
        </>
      )}
      {tab === 'rules' && (
        <>
          <label className="block text-xs">
            {t('designer.rules')}
            <textarea
              className={fieldClass}
              value={plan.rules}
              onChange={(e) => change('rules', e.target.value)}
            />
          </label>
          <label className="block text-xs">
            {t('designer.concurrency')}
            <input
              className={fieldClass}
              type="number"
              min={1}
              max={32}
              value={plan.concurrency ?? ''}
              onChange={(e) => change('concurrency', Number(e.target.value) || null)}
            />
          </label>
          <label className="block text-xs">
            <input
              type="checkbox"
              checked={plan.visualQA}
              onChange={(e) => change('visualQA', e.target.checked)}
            />{' '}
            {t('designer.visual')}
          </label>
        </>
      )}
    </section>
  );
}

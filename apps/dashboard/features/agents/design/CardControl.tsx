import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KanbanCardFull } from '@mcp/company/types.js';
import { apiPost, useApi } from '../../../hooks/useApi.js';
import { Button } from '../../../components/ui/button.js';
import { DecisionControl } from './DecisionControl.js';
import { fieldClass } from './PlanEditor.js';
export function CardControl({
  card,
  sessionId,
  onRefresh,
  onValidations,
}: {
  card: KanbanCardFull;
  sessionId: string;
  onRefresh: () => void;
  onValidations?: () => void;
}) {
  const { t } = useTranslation('agents');
  const source = useApi<{ roles: string[]; projects: { project_id: number; project_name: string }[] }>(
    '/company/sessions/' + sessionId + '/task-options',
  );
  const [control, setControl] = useState(
    () => card.control ?? { owner: null, projectId: null, visualQA: false, acceptance: [] },
  );
  const [base, setBase] = useState(card.updated_at);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError('');
    try {
      const saved = await apiPost<KanbanCardFull>(
        '/company/sessions/' + sessionId + '/kanban/' + card.id + '/control',
        { expectedUpdatedAt: base, control },
      );
      setBase(saved.updated_at);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="space-y-2 rounded border p-3">
      <div className="grid grid-cols-2 gap-2">
        <label>
          {t('designer.owner')}
          <select
            className={fieldClass}
            value={control.owner ?? ''}
            onChange={(e) => setControl({ ...control, owner: e.target.value || null })}
          >
            <option value="">{t('designer.noOwner')}</option>
            {source.data?.roles.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
        </label>
        <label>
          {t('designer.projects')}
          <select
            className={fieldClass}
            value={control.projectId ?? ''}
            onChange={(e) => setControl({ ...control, projectId: Number(e.target.value) || null })}
          >
            <option value="">—</option>
            {source.data?.projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.project_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!control.owner && (
        <DecisionControl
          kind="company"
          id={sessionId}
          cardId={card.id}
          text={card.title + ' ' + card.description}
          onChoose={(owner) => setControl({ ...control, owner })}
        />
      )}
      <h4 className="font-medium">{t('designer.validations')}</h4>
      {control.acceptance.map((a, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            className={fieldClass}
            aria-label={t('designer.criterion')}
            placeholder={t('designer.criterion')}
            value={a.criterion}
            onChange={(e) =>
              setControl({
                ...control,
                acceptance: control.acceptance.map((x, n) =>
                  n === i ? { ...x, criterion: e.target.value } : x,
                ),
              })
            }
          />
          <input
            className={fieldClass}
            aria-label={t('designer.evidence')}
            placeholder={t('designer.evidence')}
            value={a.evidence}
            onChange={(e) =>
              setControl({
                ...control,
                acceptance: control.acceptance.map((x, n) =>
                  n === i ? { ...x, evidence: e.target.value } : x,
                ),
              })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('designer.remove')}
            onClick={() =>
              setControl({ ...control, acceptance: control.acceptance.filter((_, n) => n !== i) })
            }
          >
            ×
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setControl({ ...control, acceptance: [...control.acceptance, { criterion: '', evidence: '' }] })
          }
        >
          + {t('designer.criterion')}
        </Button>
        <label>
          <input
            type="checkbox"
            checked={control.visualQA}
            onChange={(e) => setControl({ ...control, visualQA: e.target.checked })}
          />{' '}
          {t('designer.evidenceType')}
        </label>
        {control.visualQA && onValidations && (
          <Button size="sm" variant="outline" onClick={onValidations}>
            {t('designer.history')}
          </Button>
        )}
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {t('designer.save')}
        </Button>
      </div>
      {card.transitions?.slice(-5).map((x, i) => (
        <p className="text-xs text-muted-foreground" key={i}>
          {x.from} → {x.to} · {x.actor} · {new Date(x.at).toLocaleString()} {x.reason}
        </p>
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

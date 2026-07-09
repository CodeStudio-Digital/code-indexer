/**
 * Seções de entity e behavior do NodeInspector (split pelo cap de LOC).
 * Campos commitam no blur; ações de behavior têm add/remove com selects
 * simples de alvo (entidade/tela).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Plus, X } from 'lucide-react';
import type { AppBehaviorAction, AppFieldType } from '@mcp/app-studio/spec/types.js';
import { prompt } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { Field, TextInput, type InspectorProps } from './NodeInspector.js';

const FIELD_TYPES: AppFieldType[] = ['text', 'integer', 'real', 'timestamp'];
const smallControl = 'h-7 min-w-0 max-w-full rounded border bg-background px-2 text-[11px] outline-none focus:ring-1 focus:ring-ring';

export function EntitySection({ data, spec, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  const entity = data.kind === 'entity' ? data.entityName : '';
  const targetOptions = spec.database.entities.map((e) => ({ id: e.name, label: e.label }));
  const fallbackTarget = targetOptions.find((o) => o.id !== entity)?.id ?? targetOptions[0]?.id ?? '';
  const [newReferenceTarget, setNewReferenceTarget] = useState(fallbackTarget);

  useEffect(() => {
    setNewReferenceTarget(fallbackTarget);
  }, [entity, fallbackTarget]);

  if (data.kind !== 'entity') return null;

  async function addRelationship(): Promise<void> {
    if (!newReferenceTarget) return;
    const target = targetOptions.find((o) => o.id === newReferenceTarget);
    const field = await prompt({
      title: t('blueprint.inspector.fkFieldName'),
      description: target ? t('blueprint.inspector.fkFieldDescription', { target: target.label }) : undefined,
      defaultValue: `${newReferenceTarget}_id`,
      placeholder: t('blueprint.inspector.fkFieldPlaceholder'),
      confirmLabel: t('blueprint.inspector.createRelationship'),
    });
    if (field?.trim()) void onMutate({ op: 'set-field-reference', entity, target: newReferenceTarget, field: field.trim() });
  }

  return (
    <div className="space-y-2">
      <Field label={t('blueprint.inspector.name')}>
        <TextInput defaultValue={data.label} onCommit={(label) => void onMutate({ op: 'update-entity', entity, patch: { label } })} />
      </Field>
      <Field label={t('blueprint.inspector.fields')}>
        <ul className="space-y-2">
          {data.fields.map((f) => (
            <li key={f.name} className="rounded-md border bg-background/60 p-2">
              <div className="flex items-center gap-1.5">
                <input
                  defaultValue={f.label}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    if (label && label !== f.label) void onMutate({ op: 'update-field', entity, field: f.name, patch: { label } });
                  }}
                  className={cn(smallControl, 'min-w-0 flex-1 font-medium')}
                  title={t('blueprint.inspector.fieldLabel')}
                />
                <button
                  onClick={() => void onMutate({ op: 'remove-field', entity, field: f.name })}
                  className="grid h-7 w-7 place-items-center rounded border text-muted-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600"
                  title={t('blueprint.inspector.removeField')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5">
                <input
                  defaultValue={f.name}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== f.name) void onMutate({ op: 'update-field', entity, field: f.name, patch: { name } });
                  }}
                  className={cn(smallControl, 'w-full font-mono')}
                  title={t('blueprint.inspector.fieldColumn')}
                />
                <select
                  value={f.type}
                  disabled={Boolean(f.references)}
                  title={f.references ? t('blueprint.inspector.fkTypeLocked') : t('blueprint.inspector.fieldType')}
                  onChange={(e) =>
                    void onMutate({ op: 'update-field', entity, field: f.name, patch: { type: e.target.value as AppFieldType } })
                  }
                  className={cn(smallControl, 'w-full truncate', f.references && 'opacity-60')}
                >
                  {FIELD_TYPES.map((ft) => (
                    <option key={ft} value={ft}>{t(`blueprint.fieldType.${ft}`)}</option>
                  ))}
                </select>
              </div>
              <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5">
                <label className="flex h-7 shrink-0 items-center gap-1.5 rounded border bg-background px-2 text-[11px]">
                  <input
                    type="checkbox"
                    checked={Boolean(f.required)}
                    onChange={(e) => void onMutate({ op: 'update-field', entity, field: f.name, patch: { required: e.target.checked } })}
                    className="h-3 w-3"
                  />
                  {t('blueprint.inspector.required')}
                </label>
                <select
                  value={f.references ?? ''}
                  onChange={(e) => {
                    const target = e.target.value;
                    if (target) void onMutate({ op: 'set-field-reference', entity, target, field: f.name, label: f.label });
                    else void onMutate({ op: 'update-field', entity, field: f.name, patch: { references: null } });
                  }}
                  className={cn(smallControl, 'w-full truncate')}
                  title={t('blueprint.inspector.relationship')}
                >
                  <option value="">{t('blueprint.inspector.noRelationship')}</option>
                  {targetOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.id === entity ? t('blueprint.inspector.sameEntity', { name: o.label }) : o.label}</option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      </Field>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={() => {
            void prompt({ title: t('blueprint.inspector.addField'), placeholder: t('blueprint.palette.namePlaceholder') }).then(
              (label) => label?.trim() && void onMutate({ op: 'add-field', entity, label: label.trim() }),
            );
          }}
        >
          <Plus className="mr-1 h-3 w-3" /> {t('blueprint.inspector.addField')}
        </Button>
      </div>
      <div className="rounded-md border border-dashed bg-muted/20 p-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
          {t('blueprint.inspector.newRelationship')}
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
          <select
            value={newReferenceTarget}
            onChange={(e) => setNewReferenceTarget(e.target.value)}
            className={cn(smallControl, 'w-full truncate')}
          >
            {targetOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.id === entity ? t('blueprint.inspector.sameEntity', { name: o.label }) : o.label}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={!newReferenceTarget}
            onClick={() => void addRelationship()}
          >
            <Plus className="h-3 w-3" /> {t('blueprint.inspector.createRelationship')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function BehaviorSection({ data, spec, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  const [kind, setKind] = useState<AppBehaviorAction['kind']>('notify');
  const [target, setTarget] = useState('');
  if (data.kind !== 'behavior') return null;
  const id = data.behaviorId;

  async function addAction(): Promise<void> {
    let action: AppBehaviorAction | null = null;
    if (kind === 'save' && target) action = { kind: 'save', entity: target };
    else if (kind === 'navigate' && target) action = { kind: 'navigate', screen_id: target };
    else if (kind === 'notify') {
      const message = await prompt({ title: t('blueprint.action.notify'), placeholder: t('blueprint.inspector.notifyPlaceholder') });
      if (message?.trim()) action = { kind: 'notify', message: message.trim() };
    }
    if (action) void onMutate({ op: 'add-behavior-action', behavior_id: id, action });
  }

  const targets = kind === 'save' ? spec.database.entities.map((e) => ({ id: e.name, label: e.label }))
    : kind === 'navigate' ? spec.screens.map((s) => ({ id: s.id, label: s.label }))
    : [];

  return (
    <div className="space-y-2">
      <Field label={t('blueprint.inspector.triggerLabel')}>
        <TextInput defaultValue={data.label} onCommit={(trigger_label) => void onMutate({ op: 'update-behavior', behavior_id: id, patch: { trigger_label } })} />
      </Field>
      <Field label={t('blueprint.inspector.trigger')}>
        <select
          value={data.trigger}
          onChange={(e) => void onMutate({ op: 'update-behavior', behavior_id: id, patch: { trigger: e.target.value as typeof data.trigger } })}
          className="w-full rounded border bg-background px-1.5 py-1 text-xs"
        >
          {(['click', 'submit', 'open'] as const).map((tr) => (
            <option key={tr} value={tr}>{t(`blueprint.trigger.${tr}`)}</option>
          ))}
        </select>
      </Field>
      <Field label={t('blueprint.inspector.actions')}>
        <ul className="space-y-1">
          {data.actions.map((a, i) => (
            <li key={i} className="flex items-center gap-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate">
                {a.kind === 'save' && `${t('blueprint.action.save')} → ${a.entity}`}
                {a.kind === 'navigate' && `${t('blueprint.action.navigate')} → ${a.screen_id}`}
                {a.kind === 'notify' && `${t('blueprint.action.notify')}: "${a.message}"`}
              </span>
              <button
                onClick={() => void onMutate({ op: 'remove-behavior-action', behavior_id: id, index: i })}
                className="text-muted-foreground hover:text-red-600"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </Field>
      <div className="flex items-center gap-1">
        <select
          value={kind}
          onChange={(e) => { setKind(e.target.value as AppBehaviorAction['kind']); setTarget(''); }}
          className="rounded border bg-background px-1 py-1 text-[10px]"
        >
          {(['save', 'navigate', 'notify'] as const).map((k) => (
            <option key={k} value={k}>{t(`blueprint.action.${k}`)}</option>
          ))}
        </select>
        {targets.length > 0 && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="min-w-0 flex-1 rounded border bg-background px-1 py-1 text-[10px]">
            <option value="">…</option>
            {targets.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        )}
        <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={() => void addAction()}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Seções de entity e behavior do NodeInspector (split pelo cap de LOC).
 * Campos commitam no blur; ações de behavior têm add/remove com selects
 * simples de alvo (entidade/tela).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import type { AppBehaviorAction, AppFieldType } from '@mcp/app-studio/spec/types.js';
import { prompt } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Field, TextInput, type InspectorProps } from './NodeInspector.js';

const FIELD_TYPES: AppFieldType[] = ['text', 'integer', 'real', 'timestamp'];

export function EntitySection({ data, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  if (data.kind !== 'entity') return null;
  const entity = data.entityName;
  return (
    <div className="space-y-2">
      <Field label={t('blueprint.inspector.name')}>
        <TextInput defaultValue={data.label} onCommit={(label) => void onMutate({ op: 'update-entity', entity, patch: { label } })} />
      </Field>
      <Field label={t('blueprint.inspector.fields')}>
        <ul className="space-y-1">
          {data.fields.map((f) => (
            <li key={f.name} className="flex items-center gap-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate" title={f.name}>{f.label}</span>
              <select
                value={f.type}
                onChange={(e) =>
                  void onMutate({ op: 'update-field', entity, field: f.name, patch: { type: e.target.value as AppFieldType } })
                }
                className="rounded border bg-background px-1 py-0.5 text-[10px]"
              >
                {FIELD_TYPES.map((ft) => (
                  <option key={ft} value={ft}>{t(`blueprint.fieldType.${ft}`)}</option>
                ))}
              </select>
              <button
                onClick={() => void onMutate({ op: 'remove-field', entity, field: f.name })}
                className="text-muted-foreground hover:text-red-600"
                title={t('blueprint.inspector.removeField')}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </Field>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-[11px]"
        onClick={() => {
          void prompt({ title: t('blueprint.inspector.addField'), placeholder: t('blueprint.palette.namePlaceholder') }).then(
            (label) => label?.trim() && void onMutate({ op: 'add-field', entity, label: label.trim() }),
          );
        }}
      >
        <Plus className="mr-1 h-3 w-3" /> {t('blueprint.inspector.addField')}
      </Button>
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

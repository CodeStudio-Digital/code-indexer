/**
 * Inspector do nó selecionado — props editáveis por kind (inputs commitam
 * no blur → mutação cirúrgica). Remoções passam pelo confirm de cascade do
 * hook (mutate). Seções de entity/behavior em InspectorDataSections
 * (split pelo cap de LOC).
 */
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { AppSpec } from '@mcp/app-studio/spec/types.js';
import type { BlueprintMutation } from '@mcp/app-studio/blueprint/mutations.js';
import type { BlueprintNodeData } from '@mcp/app-studio/blueprint/types.js';
import { Button } from '../../../components/ui/button.js';
import { EntitySection, BehaviorSection } from './InspectorDataSections.js';

export interface InspectorProps {
  data: BlueprintNodeData;
  spec: AppSpec;
  onMutate: (m: BlueprintMutation) => Promise<boolean>;
  onClose: () => void;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function TextInput({
  defaultValue,
  onCommit,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      defaultValue={defaultValue}
      onBlur={(e) => {
        const v = e.target.value.trim();
        if (v && v !== defaultValue) onCommit(v);
      }}
      className="w-full rounded border bg-background px-2 py-1 text-xs"
    />
  );
}

function ScreenSection({ data, spec, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  if (data.kind !== 'screen') return null;
  const id = data.screenId;
  return (
    <div className="space-y-2">
      <Field label={t('blueprint.inspector.name')}>
        <TextInput defaultValue={data.label} onCommit={(label) => void onMutate({ op: 'update-screen', screen_id: id, patch: { label } })} />
      </Field>
      <Field label={t('blueprint.inspector.purpose')}>
        <TextInput defaultValue={data.purpose} onCommit={(purpose) => void onMutate({ op: 'update-screen', screen_id: id, patch: { purpose } })} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {!data.primary && (
          <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void onMutate({ op: 'update-screen', screen_id: id, patch: { primary: true } })}>
            {t('blueprint.inspector.makeHome')}
          </Button>
        )}
        {spec.auth.enabled && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            onClick={() => void onMutate({ op: data.protected ? 'unprotect-screen' : 'protect-screen', screen_id: id })}
          >
            {data.protected ? t('blueprint.inspector.unprotect') : t('blueprint.inspector.protect')}
          </Button>
        )}
      </div>
    </div>
  );
}

function FeatureSection({ data, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  if (data.kind !== 'feature') return null;
  const id = data.featureId;
  return (
    <div className="space-y-2">
      <Field label={t('blueprint.inspector.name')}>
        <TextInput defaultValue={data.label} onCommit={(name) => void onMutate({ op: 'update-feature', feature_id: id, patch: { name } })} />
      </Field>
      <Field label={t('blueprint.inspector.description')}>
        <TextInput defaultValue={data.description} onCommit={(description) => void onMutate({ op: 'update-feature', feature_id: id, patch: { description } })} />
      </Field>
    </div>
  );
}

function AuthSection({ data, spec, onMutate }: InspectorProps) {
  const { t } = useTranslation('appStudio');
  if (data.kind !== 'auth') return null;
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">{t('blueprint.inspector.authHint')}</p>
      <p className="font-mono text-[10px]">{(spec.auth.methods ?? []).join(' · ') || '—'}</p>
      <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void onMutate({ op: 'set-auth-enabled', enabled: false })}>
        {t('blueprint.inspector.disableAuth')}
      </Button>
    </div>
  );
}

/** Mutação de remoção correspondente ao nó (null = não removível: auth). */
function removalOf(data: BlueprintNodeData): BlueprintMutation | null {
  switch (data.kind) {
    case 'screen': return { op: 'remove-screen', screen_id: data.screenId };
    case 'entity': return { op: 'remove-entity', entity: data.entityName };
    case 'feature': return { op: 'remove-feature', feature_id: data.featureId };
    case 'behavior': return { op: 'remove-behavior', behavior_id: data.behaviorId };
    case 'auth': return null;
  }
}

export function NodeInspector(props: InspectorProps) {
  const { t } = useTranslation('appStudio');
  const { data, onMutate, onClose } = props;
  const removal = removalOf(data);
  return (
    <div className="flex h-full min-h-0 w-64 shrink-0 flex-col border-l bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold">{t(`blueprint.kind.${data.kind}`)}</span>
        <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <ScreenSection {...props} />
        <FeatureSection {...props} />
        <AuthSection {...props} />
        <EntitySection {...props} />
        <BehaviorSection {...props} />
      </div>
      {removal && (
        <div className="border-t p-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full text-[11px] text-red-600 hover:bg-red-500/10"
            onClick={() => {
              void onMutate(removal).then((ok) => ok && onClose());
            }}
          >
            <Trash2 className="mr-1 h-3 w-3" /> {t('blueprint.inspector.remove')}
          </Button>
        </div>
      )}
    </div>
  );
}

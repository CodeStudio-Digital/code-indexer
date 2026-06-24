/**
 * Inline "add a model manually" affordance for a provider's model list.
 *
 * The backend already supports manual model upserts
 * (`POST /providers/:id/models`, tagged `source='manual'` so the next live
 * refresh doesn't wipe it). This is the missing UI: a button that flips into
 * a compact form so the operator can add an experimental model id that
 * isn't returned by live discovery yet (e.g. a freshly-released Z.AI model).
 *
 * Kept as its own small component so `ProviderCard` doesn't grow further.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

export interface AddModelInput {
  model_id: string;
  name: string;
  mode?: string;
}

export function AddModelForm({
  onAdd,
}: {
  onAdd: (input: AddModelInput) => void;
}) {
  const { t } = useTranslation(['admin', 'common']);
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('');

  const reset = () => {
    setModelId('');
    setName('');
    setMode('');
    setOpen(false);
  };

  const commit = () => {
    // The model id must stay BARE — the `::mode` suffix is encoded by the
    // picker at selection time. If the user pastes `glm-5.2::coding` (or a
    // doubled `glm-5.2::coding::coding`) into the id field, strip everything
    // from the first `::` and fold it into the mode field. Otherwise the
    // picker double-appends (`id::mode::mode`) and capability lookups — which
    // key on the bare id — silently miss the row's overrides. The Z.AI 1M
    // suffix `[1m]` is part of the id and is intentionally preserved.
    const sep = modelId.indexOf('::');
    const id = (sep === -1 ? modelId : modelId.slice(0, sep)).trim();
    const suffixMode = sep === -1 ? '' : modelId.slice(sep + 2).replace(/::/g, '').trim();
    const finalMode = mode.trim() || suffixMode;
    if (!id) return; // server validates too
    onAdd({ model_id: id, name: name.trim() || id, mode: finalMode || undefined });
    reset();
  };

  if (!open) {
    return (
      <div className="pt-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setOpen(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> {t('admin:provider.addModel.label')}
        </Button>
      </div>
    );
  }

  const inputCls = 'h-8 rounded border bg-background px-2 text-xs font-mono';
  return (
    <div className="pt-2 flex flex-wrap items-center gap-2">
      <input
        autoFocus
        className={`${inputCls} w-44`}
        placeholder={t('admin:provider.addModel.modelIdPlaceholder')}
        value={modelId}
        onChange={(e) => setModelId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') reset();
        }}
      />
      <input
        className={`${inputCls} w-40`}
        placeholder={t('admin:provider.addModel.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') reset();
        }}
      />
      <input
        className={`${inputCls} w-28`}
        placeholder={t('admin:provider.addModel.modePlaceholder')}
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') reset();
        }}
      />
      <Button size="sm" className="h-8 text-xs" onClick={commit} disabled={!modelId.trim()}>
        {t('admin:provider.addModel.save')}
      </Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={reset}>
        {t('admin:provider.addModel.cancel')}
      </Button>
    </div>
  );
}

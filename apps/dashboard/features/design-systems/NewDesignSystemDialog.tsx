/**
 * Modal for creating a new Design System session: name + package_name +
 * stack picker + provider/model + zip upload.
 *
 * Stays minimal — the same providers/models the operator sees in the
 * Agents tab are reused via prop drilling. We don't fetch them from
 * here yet (v1 takes hand-typed values; v1.1 adds dropdowns).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useProviders } from '../../hooks/useProviders.js';
import { createDesignSystemSession, type DsStack } from './design-system-api.js';

interface Props {
  onClose: () => void;
  onCreated: (sessionId: number) => void;
}

const STACKS: Array<{ value: DsStack; label: string; helpKey: string }> = [
  { value: 'react-ts', label: 'React + TS', helpKey: 'stack.reactHelp' },
  { value: 'vue-ts', label: 'Vue 3 + TS', helpKey: 'stack.vueHelp' },
  { value: 'angular', label: 'Angular', helpKey: 'stack.angularHelp' },
];

export function NewDesignSystemDialog({ onClose, onCreated }: Props) {
  const { t } = useTranslation('designSystems');
  const { providerOptions, getModelsForProvider, getDefaultModel, loading: providersLoading } = useProviders();

  const [name, setName] = useState('');
  const [packageName, setPackageName] = useState('');
  const [stack, setStack] = useState<DsStack>('react-ts');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [zip, setZip] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick the first available provider once the list arrives.
  useEffect(() => {
    if (provider === '' && providerOptions.length > 0) {
      const firstId = providerOptions[0].id;
      setProvider(firstId);
      setModel(getDefaultModel(firstId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOptions.length]);

  const availableModels = useMemo(
    () => (provider ? getModelsForProvider(provider) : []),
    [provider, getModelsForProvider],
  );

  function handleProviderChange(next: string) {
    setProvider(next);
    setModel(getDefaultModel(next));
  }

  const valid =
    name.trim() !== '' &&
    packageName.trim() !== '' &&
    provider.trim() !== '' &&
    model.trim() !== '' &&
    zip !== null;

  async function submit() {
    if (!valid || !zip) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createDesignSystemSession({
        name: name.trim(),
        package_name: packageName.trim(),
        stack,
        master_provider: provider.trim(),
        master_model: model.trim(),
        zip,
      });
      onCreated(result.design_system_session.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card border rounded-lg shadow-lg w-full max-w-lg max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold">{t('dialog.title')}</h2>
          <button onClick={onClose} aria-label={t('dialog.close')} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="p-4 space-y-3">
          <Field label={t('dialog.sessionName')}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm border rounded px-2 py-1"
              placeholder={t('dialog.sessionNamePlaceholder')}
            />
          </Field>

          <Field label={t('dialog.packageName')}>
            <input
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              className="w-full text-sm border rounded px-2 py-1 font-mono"
              placeholder="@acme/ui"
            />
          </Field>

          <Field label={t('dialog.stack')}>
            <div className="grid grid-cols-3 gap-2">
              {STACKS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setStack(s.value)}
                  className={`border rounded px-3 py-2 text-left text-sm ${
                    stack === s.value
                      ? 'border-primary bg-primary/5 text-primary'
                      : 'hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="font-medium">{s.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{t(s.helpKey)}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('dialog.masterProvider')}>
              {providerOptions.length > 0 ? (
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={providersLoading}
                  className="w-full text-sm border rounded px-2 py-1 bg-background disabled:opacity-60"
                >
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              ) : (
                <div className="text-xs text-muted-foreground italic px-2 py-1 border rounded">
                  {providersLoading ? t('dialog.loadingProviders') : t('dialog.noProvider')}
                </div>
              )}
            </Field>
            <Field label={t('dialog.masterModel')}>
              {availableModels.length > 0 ? (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={providersLoading}
                  className="w-full text-sm border rounded px-2 py-1 font-mono bg-background disabled:opacity-60"
                >
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.mode ? ` (${m.mode})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full text-sm border rounded px-2 py-1 font-mono"
                  placeholder="claude-opus-4-7"
                />
              )}
            </Field>
          </div>

          <Field label={t('dialog.themeZip')}>
            <label className="block border-2 border-dashed rounded p-4 text-center cursor-pointer hover:bg-muted/30">
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => setZip(e.target.files?.[0] ?? null)}
              />
              {zip ? (
                <div className="text-sm">
                  <span className="font-mono">{zip.name}</span>{' '}
                  <span className="text-muted-foreground">({(zip.size / 1024).toFixed(1)} KB)</span>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                  <Upload className="h-4 w-4" /> {t('dialog.chooseZip')}
                </div>
              )}
            </label>
          </Field>

          {error && (
            <div className="border border-red-300 bg-red-50 text-red-800 text-sm p-2 rounded">
              {error}
            </div>
          )}
        </div>

        <footer className="px-4 py-3 border-t flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> {t('actions.creating')}</> : t('actions.createSession')}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1">{label}</label>
      {children}
    </div>
  );
}

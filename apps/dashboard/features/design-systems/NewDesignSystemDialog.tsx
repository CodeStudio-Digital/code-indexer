/**
 * Modal de criação do DS Studio: nome + package npm + stack (react é o
 * caminho completo, com seleção inline de elementos) + provider/model da
 * sessão de chat + zip OPCIONAL de material bruto (vira `import/`).
 *
 * O submit abre o stream SSE do scaffold e mostra as fases ao vivo
 * (instalação npm pode demorar). `onCreated` recebe os ids para abrir o
 * studio já na sessão de chat recém-criada.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Upload, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useProviders } from '../../hooks/useProviders.js';
import type { DsStack } from './design-system-api.js';
import { createDsStudio } from './studio/studio-api.js';

interface Props {
  onClose: () => void;
  onCreated: (dsSessionId: number, coderSessionId: number) => void;
}

const STACKS: Array<{ value: DsStack; label: string; helpKey: string; badgeKey?: string }> = [
  { value: 'react-ts', label: 'React + TS', helpKey: 'stack.reactHelp', badgeKey: 'stack.fullPath' },
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
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [logTail, setLogTail] = useState('');
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (provider === '' && providerOptions.length > 0) {
      const firstId = providerOptions[0].id;
      setProvider(firstId);
      setModel(getDefaultModel(firstId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOptions.length]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logTail]);

  const availableModels = useMemo(
    () => (provider ? getModelsForProvider(provider) : []),
    [provider, getModelsForProvider],
  );

  function handleProviderChange(next: string) {
    setProvider(next);
    setModel(getDefaultModel(next));
  }

  const valid =
    name.trim() !== '' && packageName.trim() !== '' && provider.trim() !== '' && model.trim() !== '';

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setLogTail('');
    setPhaseLabel(t('studio.dialogStarting'));
    try {
      const created = await createDsStudio(
        { name: name.trim(), packageName: packageName.trim(), stack, provider, model, zip },
        {
          onPhase: (_phase, label) => setPhaseLabel(label),
          onLog: (_stream, chunk) => setLogTail((prev) => (prev + chunk).slice(-4000)),
        },
      );
      onCreated(created.ds_session.id, created.coder_session_id);
    } catch (e) {
      setError((e as Error).message);
      setPhaseLabel(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">{t('studio.dialogTitle')}</h2>
          <button onClick={onClose} disabled={busy} aria-label={t('dialog.close')} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 p-4">
          <Field label={t('dialog.sessionName')}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              className="w-full rounded border px-2 py-1 text-sm"
              placeholder={t('dialog.sessionNamePlaceholder')}
            />
          </Field>

          <Field label={t('dialog.packageName')}>
            <input
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              disabled={busy}
              className="w-full rounded border px-2 py-1 font-mono text-sm"
              placeholder={t('studio.packagePlaceholder')}
            />
          </Field>

          <Field label={t('dialog.stack')}>
            <div className="grid grid-cols-3 gap-2">
              {STACKS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setStack(s.value)}
                  disabled={busy}
                  className={`rounded border px-3 py-2 text-left text-sm ${
                    stack === s.value ? 'border-primary bg-primary/5 text-primary' : 'hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="flex items-center gap-1 font-medium">
                    {s.label}
                    {s.badgeKey && (
                      <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] uppercase tracking-wide text-primary">
                        {t(s.badgeKey)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t(s.helpKey)}</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('studio.chatProvider')}>
              {providerOptions.length > 0 ? (
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={providersLoading || busy}
                  className="w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60"
                >
                  {providerOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              ) : (
                <div className="rounded border px-2 py-1 text-xs italic text-muted-foreground">
                  {providersLoading ? t('dialog.loadingProviders') : t('dialog.noProvider')}
                </div>
              )}
            </Field>
            <Field label={t('studio.chatModel')}>
              {availableModels.length > 0 ? (
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={providersLoading || busy}
                  className="w-full rounded border bg-background px-2 py-1 font-mono text-sm disabled:opacity-60"
                >
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}{m.mode ? ` (${m.mode})` : ''}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={busy}
                  className="w-full rounded border px-2 py-1 font-mono text-sm"
                />
              )}
            </Field>
          </div>

          <Field label={t('studio.importZip')}>
            <label className="block cursor-pointer rounded border-2 border-dashed p-3 text-center hover:bg-muted/30">
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                disabled={busy}
                onChange={(e) => setZip(e.target.files?.[0] ?? null)}
              />
              {zip ? (
                <div className="text-sm">
                  <span className="font-mono">{zip.name}</span>{' '}
                  <span className="text-muted-foreground">({(zip.size / 1024).toFixed(1)} KB)</span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Upload className="h-4 w-4" /> {t('studio.importZipHint')}
                </div>
              )}
            </label>
          </Field>

          {busy && phaseLabel && (
            <div className="space-y-1 rounded border bg-muted/20 p-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {phaseLabel}
              </div>
              {logTail && (
                <pre ref={logRef} className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {logTail}
                </pre>
              )}
            </div>
          )}

          {error && (
            <div className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('actions.cancel')}</Button>
          <Button size="sm" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> {t('actions.creating')}</> : t('studio.create')}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium">{label}</label>
      {children}
    </div>
  );
}

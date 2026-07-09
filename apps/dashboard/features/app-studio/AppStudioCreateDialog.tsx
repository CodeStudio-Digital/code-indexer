/**
 * Modal de criação do App Studio — MINIMALISTA para leigo: nome do app +
 * frase da ideia (opcional, vira semente da entrevista). Provider/model
 * são auto-selecionados (default do admin) e só aparecem num collapsible
 * "Opções avançadas". Progresso do scaffold em frases humanas; log
 * técnico atrás de <details>.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useProviders } from '../../hooks/useProviders.js';
import { resolveReasoningLevels } from '../chat/composer/provider-caps.js';
import { createAppStudio } from './app-studio-api.js';

export function AppStudioCreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (appSessionId: number, coderSessionId: number, idea: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const { providerOptions, getModelsForProvider, getDefaultModel, loading: providersLoading } = useProviders();

  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string>(''); // '' = auto (model default)
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [logTail, setLogTail] = useState('');
  const logRef = useRef<HTMLPreElement | null>(null);

  // Auto-pick: primeiro provider + modelo default — leigo não escolhe modelo.
  useEffect(() => {
    if (provider === '' && providerOptions.length > 0) {
      const firstId = providerOptions[0].id;
      setProvider(firstId);
      setModel(getDefaultModel(firstId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerOptions.length]);

  const models = useMemo(
    () => (provider ? getModelsForProvider(provider) : []),
    [provider, getModelsForProvider],
  );
  // Níveis de raciocínio (low/medium/high/xhigh…) que o modelo aceita. Vazio
  // = modelo sem esforço discreto → não mostra o seletor.
  const reasoningLevels = useMemo(
    () => resolveReasoningLevels(provider, providerOptions, model),
    [provider, providerOptions, model],
  );
  // Modelo trocou e não expõe o esforço escolhido → volta pro automático.
  useEffect(() => {
    if (effort && !reasoningLevels.includes(effort)) setEffort('');
  }, [reasoningLevels, effort]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logTail]);

  const canSubmit = name.trim() !== '' && provider !== '' && model !== '' && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    setLogTail('');
    try {
      const created = await createAppStudio(
        { name: name.trim(), provider, model, reasoning_effort: effort || null },
        {
          onPhase: (phase, label) => setPhaseLabel(t(`create.phase.${phase}`, { defaultValue: label })),
          onLog: (_stream, chunk) => setLogTail((prev) => (prev + chunk).slice(-6000)),
        },
      );
      onCreated(created.app_session.id, created.coder_session_id, idea.trim());
    } catch (e) {
      setError((e as Error).message);
      setPhaseLabel(null);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> {t('create.title')}
          </h2>
          <button onClick={onClose} disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 p-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('create.nameLabel')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              autoFocus
              className="w-full rounded border px-2 py-1.5 text-sm"
              placeholder={t('create.namePlaceholder')}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('create.ideaLabel')}</span>
            <textarea
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              disabled={busy}
              className="h-16 w-full rounded border px-2 py-1.5 text-sm"
              placeholder={t('create.ideaPlaceholder')}
            />
          </label>

          {providerOptions.length > 1 && (
            <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('create.advanced')}</summary>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{t('create.provider')}</span>
                  <select
                    value={provider}
                    disabled={busy || providersLoading}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      setModel(getDefaultModel(e.target.value));
                    }}
                    className="w-full rounded border bg-background px-2 py-1"
                  >
                    {providerOptions.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">{t('create.model')}</span>
                  {models.length > 0 ? (
                    <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)} className="w-full rounded border bg-background px-2 py-1">
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}{m.mode ? ` (${m.mode})` : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={model} disabled={busy} onChange={(e) => setModel(e.target.value)} className="w-full rounded border px-2 py-1 font-mono" />
                  )}
                </label>
                {reasoningLevels.length > 0 && (
                  <label className="col-span-2 block">
                    <span className="mb-1 block text-xs text-muted-foreground">
                      {t('create.effort', { defaultValue: 'Capacidade de raciocínio' })}
                    </span>
                    <select
                      value={effort}
                      disabled={busy}
                      onChange={(e) => setEffort(e.target.value)}
                      className="w-full rounded border bg-background px-2 py-1"
                    >
                      <option value="">{t('create.effortAuto', { defaultValue: 'Automático (padrão do modelo)' })}</option>
                      {reasoningLevels.map((lv) => (
                        <option key={lv} value={lv}>{lv}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </details>
          )}

          {busy && (
            <div className="space-y-2 rounded border bg-muted/20 p-3">
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                {phaseLabel ?? t('create.creating')}
              </p>
              {logTail && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t('create.showLog')}</summary>
                  <pre ref={logRef} className="mt-1 max-h-32 overflow-auto rounded bg-background p-2 text-[10px] leading-tight">
                    {logTail}
                  </pre>
                </details>
              )}
            </div>
          )}
          {error && (
            <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
              <p>{t('create.error')}</p>
              <details className="mt-1">
                <summary className="cursor-pointer">{t('create.showLog')}</summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">{error}</pre>
              </details>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t('pipeline.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            {t('create.submit')}
          </Button>
        </footer>
      </div>
    </div>
  );
}

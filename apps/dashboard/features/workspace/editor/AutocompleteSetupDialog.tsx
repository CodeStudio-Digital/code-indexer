/**
 * Completion-model guided setup — the chip's "unconfigured" fast path.
 * Preset cards → key/host form → apply (provider + model + binding + test
 * probe) → auto-enable ghost text. All fetch logic lives in
 * autocompleteSetupPresets.ts; this component is pure flow.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Sparkles } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { cn } from '../../../lib/utils.js';
import { fetchProviders, fetchProviderModels } from '../../admin/api.js';
import type { AdminProvider, AdminModel } from '../../admin/types.js';
import { AC_PRESETS, applyAcPreset, type AcPreset } from './autocompleteSetupPresets.js';
import { useAiCompleteStore } from './ai-complete-store.js';
import { apiCall } from '../../../lib/api-client.js';
import type { EditorProbeResult } from '@mcp/api-bus';

export function AutocompleteSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [preset, setPreset] = useState<AcPreset | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [providers, setProviders] = useState<AdminProvider[]>([]);
  const [models, setModels] = useState<AdminModel[]>([]);
  const [existingProviderId, setExistingProviderId] = useState('');
  const [existingModelId, setExistingModelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testWarning, setTestWarning] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState('Ghost text is on — Tab accepts, Alt+\\ triggers manually.');
  const [relatedCodeConsent, setRelatedCodeConsent] = useState(true);

  useEffect(() => {
    if (!open) {
      setPreset(null); setApiKey(''); setBaseUrl(''); setModelId('');
      setError(null); setTestWarning(null); setDone(false); setRelatedCodeConsent(true);
      setDoneMessage('Ghost text is on — Tab accepts, Alt+\\ triggers manually.');
    }
  }, [open]);

  useEffect(() => {
    if (preset?.id === 'chat-model') {
      void fetchProviders().then((ps) => setProviders(ps.filter((p) => p.enabled && p.has_key))).catch(() => undefined);
    }
  }, [preset]);

  useEffect(() => {
    if (existingProviderId) {
      void fetchProviderModels(existingProviderId).then(setModels).catch(() => setModels([]));
    }
  }, [existingProviderId]);

  const apply = async (bindAnyway = false) => {
    if (!preset) return;
    setBusy(true); setError(null); setTestWarning(null);
    const r = await applyAcPreset(preset, {
      apiKey, baseUrl, modelId, existingProviderId, existingModelId,
    }, { bindAnyway, relatedCodeConsent });
    setBusy(false);
    if (r.ok) {
      if (preset.id === 'chat-model') {
        const probe = await apiCall<EditorProbeResult>('editor.probe', {}).catch(() => null);
        setDoneMessage(probe?.verifiedForAutomatic
          ? `Completion probe passed (${probe.latency.p50 ?? '—'}ms p50). Automatic ghost text is enabled.`
          : 'Model bound as manual-only. Use Alt+\\; run the completion probe again in Admin after tuning it.');
      } else if (r.forced) {
        setDoneMessage('Binding enabled without a successful completion probe. Use Admin to retest it before relying on automatic ghost text.');
      } else if (r.probe) {
        setDoneMessage(`Completion endpoint verified (${r.probe.latency.p50 ?? '—'}ms p50). Ghost text is enabled.`);
      }
      useAiCompleteStore.getState().setEnabled(true);
      useAiCompleteStore.getState().requestNudge('enabled-hint');
      setDone(true);
      setTimeout(onClose, 1200);
    } else if (r.testWarning) {
      setTestWarning(r.testWarning);
    } else {
      setError(r.error ?? 'Something went wrong.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Set up AI completion
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="py-6 text-sm text-emerald-500">
            {doneMessage}
          </div>
        ) : !preset ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Pick a completion model. Privacy note: the code around your cursor is sent to the
              provider on each suggestion.
            </p>
            {AC_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setPreset(p); setModelId(p.modelId ?? ''); }}
                className="rounded border border-border/60 p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/30"
              >
                <div className="text-sm font-medium">{p.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{p.description}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="text-sm font-medium">{preset.label}</div>
            {preset.id === 'chat-model' ? (
              <>
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                  value={existingProviderId}
                  onChange={(e) => setExistingProviderId(e.target.value)}
                >
                  <option value="">Provider…</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                  value={existingModelId}
                  onChange={(e) => setExistingModelId(e.target.value)}
                  disabled={!existingProviderId}
                >
                  <option value="">Model…</option>
                  {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.model_id}</option>)}
                </select>
              </>
            ) : (
              <>
                {preset.keyUrl && (
                  <a
                    href={preset.keyUrl} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Get an API key <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <Input
                  type="password" placeholder="API key" value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {preset.provider?.needsBaseUrl && (
                  <Input
                    placeholder="Base URL (…/v1)" value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                )}
                {!preset.modelId && (
                  <Input
                    placeholder="Model id (e.g. qwen2.5-coder-7b)" value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                  />
                )}
              </>
            )}

            <label className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={relatedCodeConsent} onChange={(e) => setRelatedCodeConsent(e.target.checked)} />
              <span>
                Use indexed related code. Up to three relevant windows (700 tokens total) from other project files may be sent to this provider.
              </span>
            </label>

            {error && <div className="text-xs text-red-400">{error}</div>}
            {testWarning && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-400">
                {testWarning}
              </div>
            )}

            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => { setPreset(null); setError(null); setTestWarning(null); }}>
                Back
              </Button>
              <div className={cn('flex gap-2')}>
                {testWarning && (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void apply(true)}>
                    Bind anyway
                  </Button>
                )}
                <Button size="sm" disabled={busy} onClick={() => void apply(false)}>
                  {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Apply & enable
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Focused AI helper for the Scripts tab — describe a test/pre-request in plain
 * language and the model writes a `pm.*` script. One-shot (no tools/chat). The
 * result is previewed; Insert appends it to the section (never clobbers).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Loader2, Check, X } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { parseRows } from '../kv-grid/kv-utils.js';
import { redactSecrets } from './redact.js';
import type { ApiRequest } from '../types.js';
import type { ScriptAssistPayload } from '../api.js';

const SUGGESTION_IDS: Record<'pre' | 'test', string[]> = {
  test: ['suggTestStatus', 'suggTestSaveToken', 'suggTestBodyField', 'suggTestResponseTime', 'suggTestBodyShape'],
  pre: ['suggPreAuthHeader', 'suggPreTimestamp', 'suggPreRandomId'],
};

interface Props {
  target: 'pre' | 'test';
  request: ApiRequest;
  responseShape?: string;
  existing: string;
  onInsert: (code: string) => void;
  onAssist: (payload: ScriptAssistPayload) => Promise<{ script: string; explanation: string }>;
}

export function AiScriptBar({ target, request, responseShape, existing, onInsert, onAssist }: Props) {
  const { t } = useTranslation('apiClient');
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ script: string; explanation: string } | null>(null);

  const generate = async () => {
    if (!intent.trim() || busy) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await onAssist({
        target,
        intent: intent.trim(),
        request: {
          method: request.method,
          // Redact literal secrets — {{templates}} are kept (safe + useful), but a
          // raw token pasted into the path/body must not reach the AI provider.
          url: redactSecrets(request.path_template),
          headerNames: parseRows(request.headers_json).filter((x) => x.enabled && x.key).map((x) => x.key),
          bodyKind: request.body_kind,
          bodySample: request.body_json ? redactSecrets(request.body_json) : undefined,
        },
        responseShape,
        existing,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const insert = () => { if (result) { onInsert(result.script); reset(); } };
  const reset = () => { setResult(null); setIntent(''); setError(null); setOpen(false); };

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] text-primary self-start" onClick={() => setOpen(true)}>
        <Sparkles className="h-3 w-3 mr-1" /> {t('ai.askAi')}
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
        <Input
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void generate(); }}
          placeholder={target === 'test' ? t('ai.intentPlaceholderTest') : t('ai.intentPlaceholderPre')}
          className="h-7 text-xs flex-1"
          autoFocus
        />
        <Button type="button" size="sm" className="h-7 gap-1" disabled={busy || !intent.trim()} onClick={() => void generate()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {t('ai.generate')}
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title={t('ai.close')} onClick={reset}><X className="h-3.5 w-3.5" /></Button>
      </div>

      {!result && !busy && (
        <div className="flex flex-wrap gap-1">
          {SUGGESTION_IDS[target].map((id) => (
            <button key={id} type="button" className="text-[10px] px-1.5 py-0.5 rounded border border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setIntent(t(`ai.${id}`))}>
              {t(`ai.${id}`)}
            </button>
          ))}
        </div>
      )}

      {error && <div className="text-[11px] text-red-500">{error}</div>}

      {result && (
        <div className="space-y-1.5">
          {result.explanation && <div className="text-[11px] text-muted-foreground">{result.explanation}</div>}
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto rounded bg-background border p-2">{result.script}</pre>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-6" onClick={() => setResult(null)}>{t('ai.discard')}</Button>
            <Button type="button" size="sm" className="h-6 gap-1" onClick={insert}><Check className="h-3.5 w-3.5" /> {t('ai.insert')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

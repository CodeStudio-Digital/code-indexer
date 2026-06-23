/**
 * Step 3 — live scaffold progress. Shows the current phase, a streamed
 * log console (stdout/stderr of npm/git), and a clear error panel with the
 * captured stderr tail on failure.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { ScaffoldStatus } from './useScaffoldStream.js';

interface ScaffoldProgressProps {
  status: ScaffoldStatus;
  phase: { phase: string; label: string } | null;
  log: string;
  error: { message: string; stderrTail?: string } | null;
}

export function ScaffoldProgress({ status, phase, log, error }: ScaffoldProgressProps) {
  const { t } = useTranslation(['projects']);
  const logRef = useRef<HTMLPreElement>(null);

  // Pin the console to the bottom as new output streams in.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-500" />}
        {status === 'error' && <XCircle className="h-4 w-4 text-destructive" />}
        <span className="font-medium">
          {status === 'done'
            ? t('wizard.doneLabel')
            : status === 'error'
              ? t('wizard.errorLabel')
              : (phase?.label ?? t('wizard.startingLabel'))}
        </span>
      </div>

      <pre
        ref={logRef}
        className="h-48 overflow-auto rounded-md bg-muted/60 border p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap"
      >
        {log || t('wizard.noOutputYet')}
      </pre>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <p className="font-medium">{error.message}</p>
          {error.stderrTail && (
            <pre className="mt-1.5 max-h-24 overflow-auto text-[11px] font-mono whitespace-pre-wrap opacity-80">
              {error.stderrTail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

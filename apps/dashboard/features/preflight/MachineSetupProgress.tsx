import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, X } from 'lucide-react';

interface Props {
  status: 'idle' | 'running' | 'done' | 'error';
  phase: { phase: string; label: string } | null;
  log: string;
  error: { message: string; stderrTail?: string } | null;
}

export function MachineSetupProgress({ status, phase, log, error }: Props) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {status === 'done' && <Check className="h-4 w-4 text-emerald-500" />}
        {status === 'error' && <X className="h-4 w-4 text-destructive" />}
        <span>{phase ? t(`preflight.machine.phase.${phase.phase}`, phase.label) : t('preflight.machine.working')}</span>
      </div>

      {log && (
        <pre
          ref={logRef}
          className="text-[11px] font-mono bg-background border rounded p-2 max-h-48 overflow-auto leading-snug whitespace-pre-wrap"
        >
          {log}
        </pre>
      )}

      {error && (
        <div className="rounded border border-destructive/30 bg-destructive/5 text-destructive text-[12px] p-3 space-y-1">
          <div className="font-medium">{error.message}</div>
          {error.stderrTail && <pre className="text-[10.5px] whitespace-pre-wrap opacity-80">{error.stderrTail}</pre>}
        </div>
      )}
    </div>
  );
}

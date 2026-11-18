import { useTranslation } from 'react-i18next';
import { Boxes, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { CheckRow } from './CheckRow.js';
import { markPreflightDone } from './storage.js';
import { usePreflight } from './usePreflight.js';

export function PreflightWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { status, report, error, recheck } = usePreflight();

  function finish() {
    markPreflightDone();
    onDone();
  }

  function handleAction(remediation: string) {
    if (remediation === 'install-git') window.electronAPI?.openExternal?.('https://git-scm.com/downloads');
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-background/95 backdrop-blur-sm">
      <div className="w-full max-w-2xl overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b bg-card/60 px-8 py-4">
          <Boxes className="h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-semibold">{t('preflight.title')}</div>
            <div className="text-xs text-muted-foreground">{t('preflight.subtitle')}</div>
          </div>
        </div>
        <div className="flex min-h-52 flex-col gap-4 p-6">
          {status === 'loading' && <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {report && (
            <div className="space-y-2">
              {report.checks.map(check => <CheckRow key={check.id} check={check} onAction={handleAction} />)}
            </div>
          )}
          <div className="mt-auto flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => void recheck()} disabled={status === 'loading'}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('preflight.recheck')}
            </Button>
            <Button size="sm" onClick={finish} disabled={report?.blocked}>
              <ShieldCheck className="h-3.5 w-3.5" />
              {t('preflight.continue')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

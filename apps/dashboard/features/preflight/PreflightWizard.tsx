/**
 * First-run dependency wizard. Full-screen overlay (same pattern as
 * OnboardingWizard) shown ahead of onboarding when the desktop shell is
 * missing a container runtime. Two views: the checklist, and the guided
 * Podman-machine setup. "Continue" is disabled while a blocking check fails.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { usePreflight } from './usePreflight.js';
import { useMachineSetupStream } from './useMachineSetupStream.js';
import { CheckRow } from './CheckRow.js';
import { MachineSetupProgress } from './MachineSetupProgress.js';
import { markPreflightDone } from './storage.js';

const PODMAN_DOWNLOAD_URL = 'https://podman.io/docs/installation';
const WSL_DOCS_URL = 'https://learn.microsoft.com/windows/wsl/install';
const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

export function PreflightWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { status, report, error, recheck } = usePreflight();
  const machine = useMachineSetupStream();
  const [view, setView] = useState<'checks' | 'machine'>('checks');

  const finish = () => {
    markPreflightDone();
    onDone();
  };

  const openExternal = (url: string) => window.electronAPI?.openExternal?.(url);

  const onAction = (remediation: string) => {
    switch (remediation) {
      case 'install-podman':
        openExternal(PODMAN_DOWNLOAD_URL);
        break;
      case 'install-wsl2':
      case 'wsl-distro':
        openExternal(WSL_DOCS_URL);
        break;
      case 'install-git':
        openExternal(GIT_DOWNLOAD_URL);
        break;
      case 'init-machine':
      case 'start-machine':
        setView('machine');
        void machine.start();
        break;
      // free-disk / pull-or-build-image: informational for the Beta.
      default:
        break;
    }
  };

  const backToChecks = () => {
    machine.cancel();
    setView('checks');
    void recheck();
  };

  const blocked = report?.blocked ?? false;

  return (
    <div className="fixed inset-0 z-[60] bg-background/95 backdrop-blur-sm flex items-center justify-center">
      <div className="w-full max-w-2xl rounded-xl border bg-card shadow-2xl overflow-hidden">
        <div className="border-b bg-card/60 px-8 py-4 flex items-center gap-3">
          <span className="h-6 w-6 rounded-md bg-primary text-primary-foreground grid place-items-center">
            <Boxes className="h-3.5 w-3.5" />
          </span>
          <div>
            <div className="text-sm font-semibold">{t('preflight.title')}</div>
            <div className="text-[12px] text-muted-foreground">{t('preflight.subtitle')}</div>
          </div>
        </div>

        <div className="p-6 min-h-[360px] flex flex-col gap-4">
          {view === 'machine' ? (
            <>
              <div className="text-sm font-medium">{t('preflight.machine.title')}</div>
              <MachineSetupProgress status={machine.status} phase={machine.phase} log={machine.log} error={machine.error} />
              <div className="mt-auto flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={backToChecks}>
                  {t('preflight.back')}
                </Button>
                {machine.status === 'done' && (
                  <Button size="sm" onClick={backToChecks}>
                    {t('preflight.machine.recheck')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              {status === 'loading' && (
                <div className="flex-1 grid place-items-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {status === 'error' && (
                <div className="rounded border border-destructive/30 bg-destructive/5 text-destructive text-[12px] p-3">
                  {error}
                </div>
              )}
              {report && (
                <div className="space-y-2">
                  {report.checks.map((c) => (
                    <CheckRow key={c.id} check={c} onAction={onAction} busy={machine.status === 'running'} />
                  ))}
                </div>
              )}
              {blocked && (
                <div className="rounded-md border bg-muted/30 p-3 text-[12px] text-muted-foreground">
                  {t('preflight.blockedHint')}
                </div>
              )}
              <div className="mt-auto flex items-center justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={() => void recheck()} disabled={status === 'loading'}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('preflight.recheck')}
                </Button>
                <Button size="sm" onClick={finish} disabled={blocked}>
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('preflight.continue')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Progresso do deploy em passos HUMANOS (checklist com spinner no passo
 * corrente), log técnico atrás de <details>, e erro traduzido com "Pedir
 * para a IA consertar" (injeta o erro no chat) + "Tentar de novo".
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, Loader2, Rocket, Wand2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { requestStudioSend } from '../../builder/studio/studio-context-store.js';
import { streamAppLaunch, type LaunchPhaseId, type LaunchResult } from './launch-api.js';

const PHASES: LaunchPhaseId[] = ['auth', 'db', 'migrate', 'build', 'deploy', 'health', 'persist'];

export function DeployProgressCard({
  sessionId,
  projectId,
  onDone,
  onAuthRequired,
}: {
  sessionId: string;
  projectId: number;
  onDone: (result: LaunchResult) => void;
  onAuthRequired: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<LaunchPhaseId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef('');
  const [, forceLog] = useState(0);

  async function publish() {
    setRunning(true);
    setError(null);
    setPhase(null);
    logRef.current = '';
    try {
      const result = await streamAppLaunch(sessionId, {
        onPhase: setPhase,
        onLog: (chunk) => {
          logRef.current = (logRef.current + chunk).slice(-8000);
          forceLog((n) => n + 1);
        },
      });
      onDone(result);
    } catch (e) {
      const message = (e as Error).message;
      if (message === 'auth-required') {
        onAuthRequired();
      } else {
        setError(message);
      }
    } finally {
      setRunning(false);
    }
  }

  const phaseIndex = phase ? PHASES.indexOf(phase) : -1;

  return (
    <div className="space-y-2.5 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Rocket className="h-4 w-4 text-primary" /> {t('publish.title')}
      </p>

      {(running || phase) && (
        <ul className="space-y-1 text-xs">
          {PHASES.map((id, i) => {
            const done = phaseIndex > i || (!running && !error && phaseIndex >= i);
            const active = running && phaseIndex === i;
            return (
              <li key={id} className="flex items-center gap-1.5">
                {done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
                )}
                <span className={active ? 'font-medium' : done ? '' : 'text-muted-foreground'}>
                  {t(`publish.step.${id}`)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!running && (
        <Button size="sm" className="w-full" onClick={() => void publish()}>
          <Rocket className="mr-1 h-3.5 w-3.5" />
          {error ? t('publish.retry', { defaultValue: 'Tentar de novo' }) : t('publish.cta', { defaultValue: 'Publicar meu app' })}
        </Button>
      )}

      {error && (
        <div className="space-y-1.5 rounded border border-red-300 bg-red-50 p-2 dark:border-red-400/40 dark:bg-red-950/30">
          <p className="text-xs text-red-800 dark:text-red-200">
            {t('publish.error', { defaultValue: 'Algo deu errado ao publicar.' })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 w-full text-xs"
            onClick={() => requestStudioSend(projectId, t('publish.fixPrompt', { error, defaultValue: `A publicação falhou com este erro — investigue e conserte, me explicando em palavras simples: ${error}` }))}
          >
            <Wand2 className="mr-1 h-3 w-3" /> {t('publish.askAiFix', { defaultValue: 'Pedir para a IA consertar' })}
          </Button>
          <details className="text-[10px] text-muted-foreground">
            <summary className="cursor-pointer">{t('create.showLog')}</summary>
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">{error}</pre>
          </details>
        </div>
      )}

      {logRef.current && (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">{t('create.showLog')}</summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{logRef.current}</pre>
        </details>
      )}
    </div>
  );
}

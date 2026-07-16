import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { BoardPanel } from '../agents/BoardPanel.js';
import { MasterComposer } from '../agents/MasterComposer.js';
import type { useCompanyStream } from '../../hooks/useCompanyStream.js';

export function AppStudioChatRail({
  companySessionId,
  projectName,
  masterSessionId,
  initialPrompt,
  companyStream,
  onCollapse,
}: {
  appSessionId: number;
  companySessionId: number | null;
  projectId: number;
  projectName: string;
  masterSessionId: number | null;
  initialPrompt?: string | null;
  companyStream?: ReturnType<typeof useCompanyStream>;
  onCollapse?: () => void;
}) {
  const { t } = useTranslation(['appStudio', 'agents']);
  const sent = useRef(false);

  const send = async (text: string, attachments: Parameters<NonNullable<typeof companyStream>['resume']>[1] = [], options?: { thinking?: boolean }) => {
    if (!companyStream) throw new Error('The App team is unavailable.');
    if (companyStream.connected && companyStream.masterAlive) await companyStream.sendMessage(text, attachments, options);
    else await companyStream.resume(text, attachments, options);
  };

  useEffect(() => {
    if (sent.current || !initialPrompt?.trim() || !masterSessionId || !companyStream) return;
    sent.current = true;
    void send(
      `[App Studio] Ideia inicial: ${initialPrompt.trim()}\nCrie o AppPlanV1 mínimo, explique decisões reais e solicite aprovação somente quando a auditoria estiver pronta.`,
    ).catch(() => { sent.current = false; });
    // The initial idea is deliberately sent once to the persistent Master.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyStream, initialPrompt, masterSessionId]);

  if (!companySessionId || !companyStream) {
    return <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">{t('appStudio:v6.teamUnavailable')}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2.5">
        <MessagesSquare className="h-3.5 w-3.5 text-violet-400" />
        <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {t('appStudio:workflow.coordinator')}
        </span>
        {onCollapse && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onCollapse}><ChevronRight className="h-3.5 w-3.5" /></Button>}
      </header>
      {companyStream.error && <div className="border-b border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-700">{companyStream.error}</div>}
      <div className="min-h-0 flex-1 overflow-hidden">
        <BoardPanel
          messages={companyStream.boardMessages}
          masterPrompts={Array.from(companyStream.masterPrompts.values())}
          onAnswerQuestion={(promptId, answer) => companyStream.respondToMasterQuestion(promptId, answer)}
          onRespondPlan={(promptId, approved, feedback) => companyStream.respondToMasterPlan(promptId, approved, feedback)}
          sessionId={companySessionId}
          sessionName={projectName}
        />
      </div>
      <div className="shrink-0 border-t p-2">
        <MasterComposer sessionId={companySessionId} onSend={send} placeholder={t('agents:company.inputPlaceholderMaster')} />
      </div>
    </div>
  );
}

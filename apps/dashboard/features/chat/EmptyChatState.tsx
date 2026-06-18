import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareCode, PanelLeft, Plus, Sparkles } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { markRouteEvent } from '../../lib/perf/route-startup-metrics.js';

interface EmptyChatStateProps {
  onNew: () => void;
  projectId?: number;
  projectName: string;
  onOpenSidebar?: () => void;
}

export function EmptyChatState({ onNew, projectId, projectName, onOpenSidebar }: EmptyChatStateProps) {
  const { t } = useTranslation('chat');
  const suggestions = [t('empty.suggestion1'), t('empty.suggestion2'), t('empty.suggestion3'), t('empty.suggestion4')];
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      markRouteEvent('EmptyChatState:painted', { projectId, tab: 'chat', detail: 'empty-chat-state' });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, projectName]);

  return (
    <div className="flex-1 flex flex-col">
      {onOpenSidebar && (
        <div className="lg:hidden border-b px-3 py-2 flex items-center">
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label={t('openSessions')}
            className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <PanelLeft className="h-4 w-4" />
            {t('sessions')}
          </button>
        </div>
      )}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md space-y-5">
          <div className="mx-auto h-16 w-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
            <MessageSquareCode className="h-8 w-8" />
          </div>
          <div>
            <h3 className="text-xl font-semibold">{t('empty.startConversation')}</h3>
            <p className="text-sm text-muted-foreground mt-1.5">
              {t('empty.chatWith', { name: projectName })}
            </p>
          </div>
          <Button onClick={onNew} size="lg">
            <Plus className="h-4 w-4" /> {t('empty.newSession')}
          </Button>
          <div className="pt-4">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-2 flex items-center justify-center gap-1">
              <Sparkles className="h-3 w-3" /> {t('empty.tryAsking')}
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {suggestions.map((s) => (
                <Badge key={s} variant="outline" className="text-[11px] font-normal normal-case py-1 px-2.5">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

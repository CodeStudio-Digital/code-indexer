import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../../components/ui/avatar.js';
import { cn } from '../../../lib/utils.js';
import { providerAccent } from '../constants.js';

interface AssistantBubbleProps {
  providerId: string;
  streaming?: boolean;
  /** The persisted article immediately above belongs to this same user turn. */
  continuation?: boolean;
  children: React.ReactNode;
}

export function AssistantBubble({ providerId, streaming, continuation, children }: AssistantBubbleProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="group/msg w-full">
      <article className="w-full min-w-0 px-3 py-2 transition-colors hover:bg-muted/[0.018]">
        {!continuation && (
          <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
            <Avatar className="h-4 w-4 shrink-0 opacity-90">
              <AvatarFallback className={cn('text-white text-[8px]', providerAccent(providerId))}>
                <Bot className="h-2.5 w-2.5" />
              </AvatarFallback>
            </Avatar>
            <span className="font-semibold text-foreground/60">{t('messages.assistant')}</span>
            {streaming && <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />}
          </div>
        )}
        <div>{children}</div>
      </article>
    </div>
  );
}

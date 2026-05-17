import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import { Avatar, AvatarFallback } from '../../../components/ui/avatar.js';
import { cn } from '../../../lib/utils.js';
import { providerAccent } from '../constants.js';

interface AssistantBubbleProps {
  providerId: string;
  streaming?: boolean;
  children: React.ReactNode;
}

export function AssistantBubble({ providerId, streaming, children }: AssistantBubbleProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex gap-3 items-start">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className={cn('text-white text-[10px]', providerAccent(providerId))}>
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0 max-w-[100%]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
          {t('messages.assistant')}
          {streaming && <span className="text-success">●</span>}
        </div>
        <div className="rounded-2xl rounded-tl-sm border bg-card px-4 py-3 shadow-sm">{children}</div>
      </div>
    </div>
  );
}

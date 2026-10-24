import React from 'react';
import { useTranslation } from 'react-i18next';

interface AssistantBubbleProps {
  streaming?: boolean;
  /** The persisted article immediately above belongs to this same user turn. */
  continuation?: boolean;
  children: React.ReactNode;
}

export function AssistantBubble({ streaming, continuation, children }: AssistantBubbleProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="group/msg w-full">
      <article className="w-full min-w-0">
        {!continuation && streaming && (
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            <span>{t('messages.processing')}</span>
          </div>
        )}
        <div>{children}</div>
      </article>
    </div>
  );
}

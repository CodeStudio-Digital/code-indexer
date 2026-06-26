import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { copyText } from '../../../lib/clipboard.js';

interface CopyMarkdownButtonProps {
  text: string;
  compactLabel?: boolean;
}

/**
 * Tiny inline button for the assistant message header — copies the
 * concatenated markdown text of the turn to the clipboard. Visible on hover
 * over the parent `.group/msg` row, with a brief "Copied" confirmation.
 */
export function CopyMarkdownButton({ text, compactLabel = true }: CopyMarkdownButtonProps) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={t('messages.copyMarkdown')}
          className="group/action opacity-0 group-hover/msg:opacity-100 focus:opacity-100 transition-all duration-200 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground rounded-full px-1.5 py-0.5 hover:bg-muted/70"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {compactLabel && (
            <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-200 ease-out group-hover/action:max-w-16 group-hover/action:opacity-100 group-focus/action:max-w-16 group-focus/action:opacity-100">
              {copied ? t('messages.copied') : t('messages.copyMarkdown')}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{copied ? t('messages.copied') : t('messages.copyMarkdown')}</TooltipContent>
    </Tooltip>
  );
}

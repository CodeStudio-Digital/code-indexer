import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { copyText } from '../../../lib/clipboard.js';

interface CopyMarkdownButtonProps {
  text: string;
}

/**
 * Tiny inline button for the assistant message header — copies the
 * concatenated markdown text of the turn to the clipboard. Visible on hover
 * over the parent `.group/msg` row, with a brief "Copied" confirmation.
 */
export function CopyMarkdownButton({ text }: CopyMarkdownButtonProps) {
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
          className="opacity-0 group-hover/msg:opacity-100 focus:opacity-100 transition-opacity inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground rounded px-1 py-0.5 hover:bg-muted"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{copied ? t('messages.copied') : t('messages.copyMarkdown')}</TooltipContent>
    </Tooltip>
  );
}

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  FileCode2,
  Heading2,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Link,
  Minus,
} from 'lucide-react';
import { Separator } from '../../../components/ui/separator.js';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../../components/ui/tooltip.js';
import type { MarkdownAction } from './useMarkdownShortcuts.js';

interface ToolbarItem {
  action: MarkdownAction;
  icon: React.ElementType;
  labelKey: string;
  shortcut?: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const mod = isMac ? '\u2318' : 'Ctrl';

const GROUPS: ToolbarItem[][] = [
  [
    { action: 'bold', icon: Bold, labelKey: 'markdownToolbar.bold', shortcut: `${mod}+B` },
    { action: 'italic', icon: Italic, labelKey: 'markdownToolbar.italic', shortcut: `${mod}+I` },
    { action: 'strikethrough', icon: Strikethrough, labelKey: 'markdownToolbar.strikethrough', shortcut: `${mod}+Shift+X` },
    { action: 'inlineCode', icon: Code, labelKey: 'markdownToolbar.inlineCode', shortcut: `${mod}+E` },
    { action: 'codeBlock', icon: FileCode2, labelKey: 'markdownToolbar.codeBlock' },
  ],
  [
    { action: 'heading', icon: Heading2, labelKey: 'markdownToolbar.heading' },
    { action: 'unorderedList', icon: List, labelKey: 'markdownToolbar.bulletList' },
    { action: 'orderedList', icon: ListOrdered, labelKey: 'markdownToolbar.numberedList' },
    { action: 'taskList', icon: ListChecks, labelKey: 'markdownToolbar.taskList' },
    { action: 'blockquote', icon: Quote, labelKey: 'markdownToolbar.blockquote', shortcut: `${mod}+Shift+.` },
  ],
  [
    { action: 'link', icon: Link, labelKey: 'markdownToolbar.link' },
    { action: 'horizontalRule', icon: Minus, labelKey: 'markdownToolbar.horizontalRule' },
  ],
];

interface MarkdownToolbarProps {
  onAction: (action: MarkdownAction) => void;
  disabled?: boolean;
  /**
   * Optional content rendered after a separator on the right side of the
   * toolbar. Used by the composer to tuck the "session-level" controls
   * (attachment, pipeline, think, cap) into the same horizontal strip as
   * the markdown formatting buttons — keeps the busier toolbar on the
   * bottom for picker controls (agent, provider, model, send).
   */
  rightSlot?: React.ReactNode;
}

export const MarkdownToolbar = React.memo(function MarkdownToolbar({ onAction, disabled, rightSlot }: MarkdownToolbarProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-t border-dashed border-border/40">
      {GROUPS.map((group, gi) => (
        <div key={gi} className="flex items-center gap-0.5">
          {gi > 0 && <Separator orientation="vertical" className="mx-1 h-4" />}
          {group.map((item) => {
            const Icon = item.icon;
            const label = t(item.labelKey);
            const tip = item.shortcut ? `${label} (${item.shortcut})` : label;
            return (
              <Tooltip key={item.action}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    disabled={disabled}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep textarea focused
                      onAction(item.action);
                    }}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{tip}</p>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ))}
      {rightSlot && (
        <>
          <div className="flex-1" />
          <Separator orientation="vertical" className="mx-1 h-4" />
          <div className="flex items-center gap-0.5">{rightSlot}</div>
        </>
      )}
    </div>
  );
});

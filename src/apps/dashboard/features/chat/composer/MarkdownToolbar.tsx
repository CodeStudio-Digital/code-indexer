import React from 'react';
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
  label: string;
  shortcut?: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const mod = isMac ? '\u2318' : 'Ctrl';

const GROUPS: ToolbarItem[][] = [
  [
    { action: 'bold', icon: Bold, label: 'Bold', shortcut: `${mod}+B` },
    { action: 'italic', icon: Italic, label: 'Italic', shortcut: `${mod}+I` },
    { action: 'strikethrough', icon: Strikethrough, label: 'Strikethrough', shortcut: `${mod}+Shift+X` },
    { action: 'inlineCode', icon: Code, label: 'Inline code', shortcut: `${mod}+E` },
    { action: 'codeBlock', icon: FileCode2, label: 'Code block' },
  ],
  [
    { action: 'heading', icon: Heading2, label: 'Heading' },
    { action: 'unorderedList', icon: List, label: 'Bullet list' },
    { action: 'orderedList', icon: ListOrdered, label: 'Numbered list' },
    { action: 'taskList', icon: ListChecks, label: 'Task list' },
    { action: 'blockquote', icon: Quote, label: 'Blockquote', shortcut: `${mod}+Shift+.` },
  ],
  [
    { action: 'link', icon: Link, label: 'Link' },
    { action: 'horizontalRule', icon: Minus, label: 'Horizontal rule' },
  ],
];

interface MarkdownToolbarProps {
  onAction: (action: MarkdownAction) => void;
  disabled?: boolean;
}

export const MarkdownToolbar = React.memo(function MarkdownToolbar({ onAction, disabled }: MarkdownToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-t border-dashed border-border/40">
      {GROUPS.map((group, gi) => (
        <div key={gi} className="flex items-center gap-0.5">
          {gi > 0 && <Separator orientation="vertical" className="mx-1 h-4" />}
          {group.map((item) => {
            const Icon = item.icon;
            const tip = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
            return (
              <Tooltip key={item.action}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={item.label}
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
    </div>
  );
});

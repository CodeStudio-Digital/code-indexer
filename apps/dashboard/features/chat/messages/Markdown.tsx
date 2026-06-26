import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../../lib/utils.js';

interface MarkdownProps {
  text: string;
  className?: string;
}

const baseClasses =
  'prose prose-sm max-w-none text-[13px] leading-5 prose-pre:rounded-md prose-pre:p-2 prose-code:before:content-none prose-code:after:content-none prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-normal prose-table:text-[11px] prose-th:px-1.5 prose-td:px-1.5 prose-headings:mt-2 prose-headings:mb-1 prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5';

const defaultClasses =
  'dark:prose-invert prose-pre:bg-card prose-pre:border prose-pre:text-foreground prose-code:bg-muted prose-code:text-foreground prose-a:text-primary prose-strong:text-foreground';

export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  return (
    <div className={cn(baseClasses, !className && defaultClasses, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

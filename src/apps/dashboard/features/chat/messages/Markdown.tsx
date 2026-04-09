import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
  text: string;
}

export function Markdown({ text }: MarkdownProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-card prose-pre:border prose-pre:text-foreground prose-pre:rounded-lg prose-pre:p-3 prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-normal prose-code:text-foreground prose-table:text-xs prose-th:px-2 prose-td:px-2 prose-headings:mt-3 prose-headings:mb-1.5 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-a:text-primary prose-strong:text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

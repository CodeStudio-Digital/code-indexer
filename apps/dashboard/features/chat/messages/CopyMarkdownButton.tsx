import { useTranslation } from 'react-i18next';
import { CopyTextButton } from './CopyTextButton.js';
import type { ReadMarkdown } from './round-markdown.js';

export function CopyMarkdownButton({ text, iconOnly }: { text: string | ReadMarkdown; iconOnly?: boolean }) {
  const { t } = useTranslation('chat');
  return <CopyTextButton data-markdown-copy text={text} iconOnly={iconOnly} label={t('messages.copyMarkdown')}
    className="inline-flex min-h-6 items-center justify-center gap-1.5 whitespace-nowrap rounded px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring" />;
}

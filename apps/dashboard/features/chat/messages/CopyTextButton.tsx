import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Loader2 } from 'lucide-react';
import { copyText } from '../../../lib/clipboard.js';
import type { ReadMarkdown } from './round-markdown.js';

export function CopyTextButton({ text, label: action, iconOnly, ...attributes }: {
  text: string | ReadMarkdown;
  label: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('chat');
  const [feedback, setFeedback] = useState<'copied' | 'copyFailed' | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { request.current?.abort(); clearTimeout(timer.current); }, []);
  const label = feedback ? t(`messages.${feedback}`) : action;
  return (
    <button {...attributes} type="button" title={label} aria-label={label} aria-busy={busy} disabled={busy}
      onClick={async event => {
        event.stopPropagation();
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        let copied = false;
        try {
          const source = typeof text === 'function' ? text(controller.signal) : text;
          const content = typeof source === 'string' ? source : await source;
          if (!controller.signal.aborted) copied = await copyText(content);
        } catch { /* Keep the clipboard intact if a history page could not be read. */ }
        if (controller.signal.aborted) return;
        request.current = null;
        setBusy(false);
        setFeedback(copied ? 'copied' : 'copyFailed');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFeedback(null), 1500);
      }}>
      {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
        : feedback === 'copied' ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
      <span aria-live="polite" className={iconOnly ? 'sr-only' : undefined}>{label}</span>
    </button>
  );
}

/**
 * Renders a pipeline stage's output as Markdown with a Copy button and an
 * "expand" action that opens it larger in a modal — the sidebar is narrow,
 * so the modal is where you actually read long stage output.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check, Maximize2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../../../../components/ui/dialog.js';
import { Markdown } from '../../messages/Markdown.js';

interface PipelineStageOutputProps {
  title: string;
  text: string;
}

export function PipelineStageOutput({ title, text }: PipelineStageOutputProps) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — best-effort */
    }
  };

  return (
    <div className="border-t bg-muted/30">
      <div className="flex items-center justify-end gap-1 px-1.5 py-1">
        <IconBtn onClick={copy} title={t('pipelineRuntime.copy', { defaultValue: 'Copy' })}>
          {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        </IconBtn>
        <IconBtn onClick={() => setOpen(true)} title={t('pipelineRuntime.expand', { defaultValue: 'Expand' })}>
          <Maximize2 className="h-3 w-3" />
        </IconBtn>
      </div>
      <div className="max-h-60 overflow-auto px-2 pb-2 text-[11px]">
        <Markdown text={text} />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6 text-sm">
              <span className="truncate">{title}</span>
              <button
                type="button"
                onClick={copy}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-muted"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {t('pipelineRuntime.copy', { defaultValue: 'Copy' })}
              </button>
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto pr-1 text-sm">
            <Markdown text={text} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconBtn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
    >
      {children}
    </button>
  );
}

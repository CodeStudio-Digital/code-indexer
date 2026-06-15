/**
 * AI ghost-text toggle chip (StatusBar). One glance = one state:
 *   gray    — off (click enables; the feature is opt-in, default OFF)
 *   green   — on, idle/working
 *   spinner — on, completion request in flight
 *   amber   — on but degraded: no binding configured, model timing out,
 *             or provider erroring. The tooltip carries the actual cause
 *             (silent snoozes used to read as "it never works").
 */
import { Loader2, Sparkles } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip.js';
import { cn } from '../../../../lib/utils.js';
import { useAiCompleteStore } from '../../editor/inlineCompletionProvider.js';

export function AiCompleteChip() {
  const enabled = useAiCompleteStore((s) => s.enabled);
  const busy = useAiCompleteStore((s) => s.busy);
  const issue = useAiCompleteStore((s) => s.issue);
  const setEnabled = useAiCompleteStore((s) => s.setEnabled);

  const tone = !enabled
    ? 'text-muted-foreground/60'
    : issue
      ? 'text-amber-400'
      : 'text-emerald-400';

  const hint = !enabled
    ? 'AI completion is off — click to enable ghost-text suggestions.'
    : issue?.kind === 'unconfigured'
      ? 'AI completion is enabled but no model is bound. Configure the editor/autocomplete binding in Admin → Pipelines.'
      : issue?.kind === 'timeout'
        ? `Last completion timed out: ${issue.message ?? 'the bound model is too slow for ghost text — bind a fast model or raise timeout_ms in the binding config.'}`
        : issue?.kind === 'provider_error'
          ? `Provider error: ${issue.message ?? 'check the editor/autocomplete binding in Admin → Pipelines.'}`
          : 'AI completion is on — code near the cursor is sent to the configured provider. Click to disable.';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setEnabled(!enabled)}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-muted/40',
            tone,
          )}
        >
          {enabled && busy ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Sparkles className="h-2.5 w-2.5" />
          )}
          <span>AI</span>
          {enabled && issue && <span className="text-[9px]">!</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-[11px] leading-snug max-w-[280px]">{hint}</div>
      </TooltipContent>
    </Tooltip>
  );
}

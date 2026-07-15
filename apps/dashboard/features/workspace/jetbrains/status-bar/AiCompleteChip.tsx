/**
 * AI ghost-text chip (StatusBar). One glance = one state:
 *   gray    — off (click enables; opt-in, default OFF)
 *   green   — on (pulses softly while a suggestion is on screen)
 *   spinner — request in flight
 *   amber   — degraded: unconfigured / timeout / provider error (tooltip
 *             carries the cause; unconfigured click opens the setup dialog)
 * The tooltip lazily loads live quality stats (editor.stats, memoized 60s).
 * A one-shot popover (nudge) surfaces setup/enable hints — there is no toast
 * infrastructure in the app, the chip anchor is the notification.
 */
import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip.js';
import { Popover, PopoverContent, PopoverAnchor } from '../../../../components/ui/popover.js';
import { Button } from '../../../../components/ui/button.js';
import { cn } from '../../../../lib/utils.js';
import { apiCall } from '../../../../lib/api-client.js';
import type { EditorStatsResult } from '@mcp/api-bus';
import { useAiCompleteStore } from '../../editor/ai-complete-store.js';
import { AutocompleteSetupDialog } from '../../editor/AutocompleteSetupDialog.js';

// Module-level 60s memo — tooltip hovers must not hammer SQLite.
let statsCache: { at: number; value: EditorStatsResult } | null = null;

function useAiCompleteStats(active: boolean): EditorStatsResult | null {
  const [stats, setStats] = useState<EditorStatsResult | null>(statsCache?.value ?? null);
  useEffect(() => {
    if (!active) return;
    if (statsCache && Date.now() - statsCache.at < 60_000) { setStats(statsCache.value); return; }
    let alive = true;
    void apiCall<EditorStatsResult>('editor.stats', { days: 7 })
      .then((v) => {
        statsCache = { at: Date.now(), value: v };
        if (alive) setStats(v);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [active]);
  return stats;
}

const KEY_HINTS = 'Tab accept · Ctrl+Right word · Ctrl+Shift+Right line · Alt+\\ trigger · Esc dismiss';

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function topDiscardReason(reasons: Record<string, number>): string | null {
  const first = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  return first ? `${first[0]} (${first[1]})` : null;
}

export function AiCompleteChip() {
  const { t } = useTranslation('workspace');
  const enabled = useAiCompleteStore((s) => s.enabled);
  const busy = useAiCompleteStore((s) => s.busy);
  const issue = useAiCompleteStore((s) => s.issue);
  const suggestionVisible = useAiCompleteStore((s) => s.suggestionVisible);
  const nudge = useAiCompleteStore((s) => s.nudge);
  const setEnabled = useAiCompleteStore((s) => s.setEnabled);
  const requestNudge = useAiCompleteStore((s) => s.requestNudge);
  const [hovered, setHovered] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const stats = useAiCompleteStats(hovered);
  const currentDelivery = stats?.current.delivery
    ?? { received: 0, returned: 0, discarded: 0, discardReasons: {} };
  const discardReason = topDiscardReason(currentDelivery.discardReasons);

  // Nudge auto-dismiss.
  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => requestNudge(null), 15_000);
    return () => clearTimeout(t);
  }, [nudge, requestNudge]);

  const tone = !enabled
    ? 'text-muted-foreground/60'
    : issue
      ? 'text-amber-400'
      : 'text-emerald-400';

  const hint = !enabled
    ? 'AI completion is off — click to enable ghost-text suggestions.'
    : issue?.kind === 'unconfigured'
      ? 'AI completion is enabled but no model is bound. Click to set one up.'
      : issue?.kind === 'manual_only'
        ? `The bound chat model is manual-only: ${issue.message ?? 'run the completion probe or use Alt+\\.'}`
      : issue?.kind === 'timeout'
        ? `Last completion timed out: ${issue.message ?? 'the bound model is too slow for ghost text — bind a fast model or raise timeout_ms.'}`
        : issue?.kind === 'provider_error'
          ? `Provider error: ${issue.message ?? 'check the editor/autocomplete binding in Admin → Pipelines.'}`
          : 'AI completion is on — code near the cursor is sent to the configured provider. Click to disable.';

  const onClick = () => {
    if (enabled && (issue?.kind === 'unconfigured' || issue?.kind === 'manual_only')) {
      setSetupOpen(true);
      return;
    }
    const next = !enabled;
    setEnabled(next);
    if (next && statsCache && !statsCache.value.configured) requestNudge('unconfigured');
  };

  const nudgeText = nudge === 'unconfigured'
    ? 'No completion model is configured yet.'
    : nudge === 'enable-hint'
      ? 'AI completion is off. Click the chip (or use this button) to turn it on.'
      : 'AI completion enabled — Tab accepts, Alt+\\ triggers manually. Click the chip to turn off.';

  return (
    <>
      <Popover open={nudge !== null} onOpenChange={(o) => !o && requestNudge(null)}>
        <PopoverAnchor asChild>
          <span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onClick}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:bg-muted/40',
                    tone,
                  )}
                >
                  {enabled && busy ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <Sparkles className={cn('h-2.5 w-2.5', suggestionVisible && 'animate-pulse')} />
                  )}
                  <span>AI</span>
                  {enabled && issue && <span className="text-[9px]">!</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="max-w-[300px] text-[11px] leading-snug">
                  <div>{hint}</div>
                  {stats?.configured && (
                    <div className="mt-1.5 border-t border-border/40 pt-1.5 text-muted-foreground">
                      <div>
                        {stats.model} · {stats.route?.suitability ?? 'unknown'} · {stats.route?.health ?? 'unknown'}
                      </div>
                      <div>
                        {t('aiComplete.currentMetrics', { accept: pct(stats.current.acceptRate), p50: stats.current.latency.p50 ?? '—', requests: stats.current.requests })}
                      </div>
                      <div>
                        {t('aiComplete.deliveryMetrics', { received: currentDelivery.received, returned: currentDelivery.returned, shown: stats.current.shown, accepted: stats.current.accepted })}
                      </div>
                      {currentDelivery.discarded > 0 && (
                        <div className="text-amber-300">
                          {t('aiComplete.discarded', { count: currentDelivery.discarded })}{discardReason ? ` · ${discardReason}` : ''}
                        </div>
                      )}
                      {stats.route?.reason && <div className="mt-1 text-amber-300">{stats.route.reason}</div>}
                      <div className="mt-1 opacity-80">{KEY_HINTS}</div>
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          </span>
        </PopoverAnchor>
        <PopoverContent side="top" className="w-64 p-3">
          <div className="text-xs">{nudgeText}</div>
          <div className="mt-2 flex justify-end gap-2">
            {nudge === 'unconfigured' && (
              <Button size="sm" onClick={() => { requestNudge(null); setSetupOpen(true); }}>
                Set up completion model
              </Button>
            )}
            {nudge === 'enable-hint' && (
              <Button size="sm" onClick={() => { requestNudge(null); setEnabled(true); }}>
                Enable
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <AutocompleteSetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} />
    </>
  );
}

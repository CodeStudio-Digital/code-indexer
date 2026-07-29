/**
 * C1 — organism-visibility feed. Renders the autonomy slice's bounded ring
 * (scheduler dispatches/skips, auto-approvals, supervisor incidents, master
 * nudges) newest-first, with type filter chips and relative timestamps.
 *
 * Defensive by contract: the dashboard has no tsc gate, so every field is
 * treated as possibly missing.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, BellRing, CheckCheck, Rocket, SkipForward } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { selectAutonomy, useCompanyStore } from '../../../state/company/index.js';
import type { AutonomyEvent, AutonomyEventType } from '../../../state/company/index.js';

const FILTERS = ['all', 'dispatch', 'approval', 'incident', 'nudge', 'skip'] as const;
type Filter = (typeof FILTERS)[number];

const TYPE_ICONS: Record<AutonomyEventType, LucideIcon> = {
  dispatch: Rocket,
  approval: CheckCheck,
  incident: AlertTriangle,
  nudge: BellRing,
  skip: SkipForward,
};

const TYPE_COLORS: Record<AutonomyEventType, string> = {
  dispatch: 'text-sky-500',
  approval: 'text-emerald-500',
  incident: 'text-destructive',
  nudge: 'text-amber-500',
  skip: 'text-muted-foreground',
};

function relativeTime(atMs: number, lang: string): string {
  const deltaSec = Math.round((atMs - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang || 'en', { numeric: 'auto' });
    if (abs < 60) return rtf.format(deltaSec, 'second');
    if (abs < 3600) return rtf.format(Math.round(deltaSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(deltaSec / 3600), 'hour');
    return rtf.format(Math.round(deltaSec / 86400), 'day');
  } catch {
    return '';
  }
}

export function AutonomyActivityFeed({ sessionId = null }: { sessionId?: string | null }) {
  const { t, i18n } = useTranslation('agents');
  const state = useCompanyStore((s) => selectAutonomy(s, sessionId ?? null));
  const [filter, setFilter] = useState<Filter>('all');

  const events = Array.isArray(state.events) ? state.events : [];
  const visible = [...events]
    .reverse()
    .filter((ev) => ev && (filter === 'all' || ev.type === filter));

  function eventText(ev: AutonomyEvent): string {
    switch (ev.event) {
      case 'scheduler_dispatched':
        return t('company.autonomy.feed.dispatched', {
          role: ev.role ?? '?', cardId: ev.cardId ?? '?',
        });
      case 'scheduler_sweep':
        return t('company.autonomy.feed.sweep', {
          dispatched: ev.dispatched ?? 0, freeSlots: ev.freeSlots ?? 0,
        });
      case 'scheduler_skipped':
        return t('company.autonomy.feed.skipped', {
          cardId: ev.cardId ?? '?', reason: ev.reason ?? '?',
        });
      case 'plan_auto_approved':
        return t('company.autonomy.feed.autoApproved', { role: ev.role ?? '?' });
      case 'supervisor_incident':
        return t('company.autonomy.feed.incident', { kind: ev.kind ?? '?' });
      case 'master_nudge':
        return t('company.autonomy.feed.nudge', { kind: ev.kind ?? '?' });
      default:
        // REST-hydrated board posts carry their content in `detail`.
        return ev.detail ?? t('company.autonomy.feed.generic');
    }
  }

  return (
    <div className="space-y-1.5">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-1.5 py-0.5 text-[9px] transition-colors',
              filter === f
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-transparent bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`company.autonomy.feed.filter.${f}`)}
          </button>
        ))}
      </div>

      {visible.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center py-3">
          {events.length === 0 && state.config?.scheduler === false
            ? t('company.autonomy.feed.emptySchedulerOff')
            : t('company.autonomy.feed.empty')}
        </p>
      )}

      <div className="space-y-1 max-h-56 overflow-y-auto pr-0.5">
        {visible.map((ev) => {
          const Icon = TYPE_ICONS[ev.type] ?? Rocket;
          return (
            <div key={ev.id} className="flex items-start gap-1.5 rounded border bg-card/40 px-1.5 py-1">
              <Icon className={cn('h-3 w-3 shrink-0 mt-0.5', TYPE_COLORS[ev.type] ?? '')} />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] leading-snug break-words">{eventText(ev)}</p>
                {ev.event === 'supervisor_incident' && ev.detail && (
                  <p className="text-[9px] text-muted-foreground truncate" title={ev.detail}>
                    {ev.detail}
                  </p>
                )}
              </div>
              <span className="text-[9px] text-muted-foreground shrink-0 whitespace-nowrap">
                {relativeTime(ev.atMs ?? Date.now(), i18n.language)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * C1 — dismissible banner for SEVERE supervisor incidents (quarantine /
 * ghost / read-only), fed by the autonomy slice ring (live
 * `supervisor_incident` SSE events).
 *
 * Only incidents inside a recent window are surfaced, so historical
 * incidents hydrated from REST don't flash a red banner on every mount.
 * Dismissals are remembered per-session at module scope so a remount
 * doesn't resurrect an already-dismissed banner.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, X } from 'lucide-react';
import { selectAutonomy, useCompanyStore } from '../../../state/company/index.js';
import type { AutonomyEvent } from '../../../state/company/index.js';

/** Incident kinds severe enough to interrupt the user (AgentSupervisor emits these). */
const SEVERE_KINDS = new Set([
  'agent_quarantined',
  'role_quarantined',
  'ghost_running',
  'read_only_mode',
]);

/** Only incidents newer than this are banner-worthy. */
const RECENT_WINDOW_MS = 10 * 60 * 1000;

/** Survives remounts (module scope); reset only on full reload. */
const dismissedBySession = new Map<number, number>();

export function AutonomyIncidentBanner({ sessionId = null }: { sessionId?: number | null }) {
  const { t } = useTranslation('agents');
  const state = useCompanyStore((s) => selectAutonomy(s, sessionId ?? null));
  const [, bump] = useState(0);

  if (sessionId == null) return null;

  const floor = Math.max(
    dismissedBySession.get(sessionId) ?? 0,
    Date.now() - RECENT_WINDOW_MS,
  );
  const events = Array.isArray(state.events) ? state.events : [];
  let incident: AutonomyEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'incident' && ev.kind && SEVERE_KINDS.has(ev.kind) && (ev.atMs ?? 0) > floor) {
      incident = ev;
      break;
    }
  }
  if (!incident) return null;

  return (
    <div className="mx-3 mt-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs flex items-start gap-2">
      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-destructive">
          {t('company.autonomy.banner.title', { kind: incident.kind })}
        </p>
        {incident.detail && (
          <p className="text-muted-foreground truncate" title={incident.detail}>
            {incident.detail}
          </p>
        )}
        <button
          type="button"
          className="mt-1 underline text-muted-foreground hover:text-foreground transition-colors"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('mcp:sidebar-section:open', { detail: { storageKey: 'autonomy' } }),
            )
          }
        >
          {t('company.autonomy.banner.viewPanel')}
        </button>
      </div>
      <button
        type="button"
        aria-label={t('company.autonomy.banner.dismiss')}
        title={t('company.autonomy.banner.dismiss')}
        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        onClick={() => {
          dismissedBySession.set(sessionId, incident.atMs ?? Date.now());
          bump((v) => v + 1);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

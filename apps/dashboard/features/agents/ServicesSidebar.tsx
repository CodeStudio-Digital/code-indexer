/**
 * ServicesSidebar — lists the secondary microservice containers of a
 * builder session and lets the user add or remove one. Coordinator
 * component for the `services-sidebar/` cluster:
 *
 *   - `useServicesPolling`   — `GET /services` every 5s.
 *   - `useServiceActions`    — pause/unpause/restart-dev/start/retry/remove.
 *   - `ServiceListItem`      — per-row render.
 *   - `AddServiceForm`       — the "+" form (scaffold / external / attached).
 *   - `types.ts`             — shared `ServiceRow`, `KNOWN_STACKS`,
 *                              `statusClassName` color helper.
 *
 * Data source: `GET /api/company/sessions/:id/services`; writes go
 * through the orchestrator so the metaBus picks up `sandbox.service.*`
 * events and the live UI stays in sync without a second stream.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { selectSandbox, useCompanyStore } from '../../state/company/index.js';
import { AddServiceForm } from './services-sidebar/AddServiceForm.js';
import { ServiceListItem } from './services-sidebar/ServiceListItem.js';
import { ServiceLogsPane } from './services-sidebar/ServiceLogsPane.js';
import { ServiceTransitionsTimeline } from './services-sidebar/ServiceTransitionsTimeline.js';
import { useServicesPolling } from './services-sidebar/useServicesPolling.js';
import { useServiceActions } from './services-sidebar/useServiceActions.js';
import type { ServicesSidebarProps } from './services-sidebar/types.js';

/**
 * B6 — expanded detail under a service row: Logs (live tail + history)
 * and Timeline (status/health transitions) as two tiny tabs, following
 * the sidebar's compact text-[9/10px] visual language.
 */
function ServiceDetail({ sessionId, serviceId }: { sessionId: number; serviceId: string }) {
  const { t } = useTranslation('agents');
  const [tab, setTab] = useState<'logs' | 'timeline'>('logs');
  const tabClass = (active: boolean) =>
    'rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ' +
    (active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent');
  return (
    <div className="ml-1 pl-1 border-l border-border/60">
      <div className="mt-1 flex items-center gap-1">
        <button type="button" className={tabClass(tab === 'logs')} onClick={() => setTab('logs')}>
          {t('services.detail.logsTab')}
        </button>
        <button type="button" className={tabClass(tab === 'timeline')} onClick={() => setTab('timeline')}>
          {t('services.detail.timelineTab')}
        </button>
      </div>
      {tab === 'logs' ? (
        <ServiceLogsPane sessionId={sessionId} serviceId={serviceId} />
      ) : (
        <ServiceTransitionsTimeline sessionId={sessionId} serviceId={serviceId} />
      )}
    </div>
  );
}

export default function ServicesSidebar({ sessionId, embedded }: ServicesSidebarProps & { embedded?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { services, loading, error, reload, setError } = useServicesPolling(sessionId);
  const actions = useServiceActions({ sessionId, services, reload, setError });
  // B8 — live supervisor verdicts (SSE). Host-process rows (`kind:
  // 'local'`) have no persisted health column, so the `/services`
  // refetch always reports 'unknown' for them — the event map is their
  // only live source and is overlaid below. Container rows keep the
  // refetched (persisted) value. Defensive `?? {}`-less read: the slice
  // initial state provides the map; older slots fall back to undefined.
  const serviceHealth = useCompanyStore(
    (s) => selectSandbox(s, sessionId).serviceHealth,
  );
  const withLiveHealth = services.map((svc) => {
    if (svc.kind !== 'local') return svc;
    const live = serviceHealth?.[svc.service_id];
    if (!live) return svc;
    return {
      ...svc,
      health: live.health,
      health_detail: live.detail ?? svc.health_detail,
      last_health_at_ms: live.at,
    };
  });

  // When `embedded` (wrapped in a parent SidebarSection that already
  // provides the header), drop our own header — the parent owns the
  // section chrome. Action buttons stay above the list so reload + add
  // are still reachable.
  const Header = embedded ? null : (
    <div className="flex items-center justify-between mb-1.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Microservices
      </span>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5"
          onClick={() => void reload()} title="Reload services">
          <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-5 w-5"
          onClick={() => setAdding(true)} title="Add microservice">
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );

  // Embedded mode renders just the inline actions row (no label, no
  // duplicate border) so it sits cleanly inside SidebarSection.
  const EmbeddedActions = !embedded ? null : (
    <div className="flex items-center justify-end gap-1 mb-1.5">
      <Button type="button" variant="ghost" size="icon" className="h-5 w-5"
        onClick={() => void reload()} title="Reload services">
        <RefreshCw className={'h-3 w-3 ' + (loading ? 'animate-spin' : '')} />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-5 w-5"
        onClick={() => setAdding(true)} title="Add microservice">
        <Plus className="h-3 w-3" />
      </Button>
    </div>
  );

  const body = (
    <>
      {Header}
      {EmbeddedActions}
      {services.length === 0 && (
        <div className="text-[10px] text-muted-foreground px-1 py-1">
          No services yet. The primary container appears here once the session provisions. Use
          the + button to add a microservice (e.g. a backend worker or PHP API).
        </div>
      )}
      <div className="space-y-1">
        {withLiveHealth.map((svc) => (
          <div key={svc.service_id}>
            <ServiceListItem
              svc={svc}
              actions={actions}
              expanded={expandedId === svc.service_id}
              onToggleExpand={
                // B8 — host-process rows have no persisted logs/transitions
                // (their output rides the LPM event overlay), so the
                // logs/timeline detail expansion is container-only.
                svc.kind === 'local'
                  ? undefined
                  : () =>
                      setExpandedId((prev) => (prev === svc.service_id ? null : svc.service_id))
              }
            />
            {expandedId === svc.service_id && svc.kind !== 'local' && (
              <ServiceDetail sessionId={sessionId} serviceId={svc.service_id} />
            )}
          </div>
        ))}
      </div>
      {adding && (
        <AddServiceForm
          sessionId={sessionId}
          onCancel={() => { setAdding(false); setError(null); }}
          onCreated={async () => { setAdding(false); setError(null); await reload(); }}
          onError={setError}
        />
      )}
      {error && <div className="text-[10px] text-red-500 px-1 pt-1">{error}</div>}
    </>
  );

  // Embedded: no outer wrapper (SidebarSection provides p-2 + borders).
  // Standalone: keep the legacy wrapper so direct mounts still look right.
  return embedded ? <>{body}</> : <div className="px-2.5 py-2 border-t">{body}</div>;
}

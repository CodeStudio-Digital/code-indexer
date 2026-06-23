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
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { AddServiceForm } from './services-sidebar/AddServiceForm.js';
import { ServiceListItem } from './services-sidebar/ServiceListItem.js';
import { useServicesPolling } from './services-sidebar/useServicesPolling.js';
import { useServiceActions } from './services-sidebar/useServiceActions.js';
import type { ServicesSidebarProps } from './services-sidebar/types.js';

export default function ServicesSidebar({ sessionId, embedded }: ServicesSidebarProps & { embedded?: boolean }) {
  const [adding, setAdding] = useState(false);
  const { services, loading, error, reload, setError } = useServicesPolling(sessionId);
  const actions = useServiceActions({ sessionId, services, reload, setError });

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
        {services.map((svc) => (
          <ServiceListItem key={svc.service_id} svc={svc} actions={actions} />
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

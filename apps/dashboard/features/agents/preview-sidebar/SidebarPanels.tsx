/**
 * Content slot for the agents-view right drawer. Renders one of the
 * panels (Company-Config / Inbox / Env / Supervisor / Databases, plus
 * plugin webviews) based on the `active` selection from `SidebarRail`.
 *
 * Inbox / Env / Databases reuse the existing tab bodies; mounting them
 * here instead of as central tabs lets the user peek at them alongside
 * whatever central tab is open.
 */
import { InboxPanel } from '../InboxPanel.js';
import EnvTab from '../EnvTab.js';
import DatabasesTab from '../DatabasesTab.js';
import { SupervisorPanel } from '../../admin/SupervisorPanel.js';
import { WebviewWindow } from '../../workspace/jetbrains/tool-windows/WebviewWindow.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';
import type { SidePanel } from './SidebarRail.js';

interface SidebarPanelsProps {
  sessionId: number;
  active: SidePanel;
  /**
   * Pre-built `<AgentsSidebar />` element passed down from
   * `CompanySessionView`. We do prop-drilling instead of letting this
   * panel construct its own AgentsSidebar because the agents sidebar
   * needs 12+ closures (refetch, openAgentRun, providerOptions, etc)
   * that the parent already has in scope. Treating it as a slot keeps
   * the dependency graph one-way and avoids a context for a single
   * caller.
   */
  companyConfigSlot?: React.ReactNode;
  /** Contributed tool windows — render the matching one's webview. */
  pluginWindows?: ContribToolWindow[];
}

export function SidebarPanels({ sessionId, active, companyConfigSlot, pluginWindows = [] }: SidebarPanelsProps) {
  // Plugin-contributed tool window → its sandboxed webview fills the drawer.
  if (active.startsWith('plugin:')) {
    const win = pluginWindows.find((w) => `plugin:${w.pluginNs}:${w.id}` === active);
    return win ? (
      <WebviewWindow namespace={win.pluginNs} title={win.title} entry={win.entry} />
    ) : null;
  }

  if (active === 'company-config') {
    // Slot is non-null in normal use; the guard keeps the panel from
    // crashing if a caller somehow opens the rail entry without
    // wiring the slot.
    return <>{companyConfigSlot ?? null}</>;
  }

  if (active === 'inbox') {
    return <InboxPanel companySessionId={sessionId} />;
  }

  if (active === 'env') {
    return <EnvTab companySessionId={sessionId} />;
  }

  if (active === 'supervisor') {
    // Session-scoped supervisor view — filters status + incidents +
    // SSE stream to this session only. The same component shows the
    // global view in `/telemetry` (when no sessionId prop).
    return <SupervisorPanel sessionId={sessionId} />;
  }

  return <DatabasesTab companySessionId={sessionId} />;
}

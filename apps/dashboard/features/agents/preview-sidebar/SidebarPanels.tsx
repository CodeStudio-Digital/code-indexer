/**
 * Content slot for the agents-view right drawer. Renders one of the
 * four panels (Preview / Inbox / Env / Databases) based on the
 * `active` selection from `SidebarRail`.
 *
 * Preview reuses the builder's `PreviewIframe` (toolbar + iframe +
 * service switcher + log overlay). Inbox / Env / Databases reuse the
 * existing tab bodies; mounting them here instead of as central tabs
 * lets the user peek at them alongside whatever central tab is open.
 */
import { selectSandbox, useCompanyStore } from '../../../state/company/index.js';
import { PreviewIframe } from '../../builder/preview/preview-iframe/PreviewIframe.js';
import { useSandboxStatus } from '../../builder/useSandboxStatus.js';
import { InboxPanel } from '../InboxPanel.js';
import EnvTab from '../EnvTab.js';
import DatabasesTab from '../DatabasesTab.js';
import { useExtraServices } from './useExtraServices.js';
import type { SidePanel } from './SidebarRail.js';

interface SidebarPanelsProps {
  sessionId: number;
  active: SidePanel;
}

export function SidebarPanels({ sessionId, active }: SidebarPanelsProps) {
  const { data, refresh, retry, restartDev } = useSandboxStatus(sessionId);
  const extraServices = useExtraServices(sessionId);

  const fileChangeTick = useCompanyStore(
    (s) => selectSandbox(s, sessionId).lastFileChange?.seq ?? 0,
  );

  if (active === 'preview') {
    return (
      <PreviewIframe
        snapshot={data}
        onRefresh={refresh}
        onRetry={retry}
        onRestartDev={restartDev}
        sessionId={sessionId}
        fileChangeTick={fileChangeTick}
        extraServices={extraServices}
      />
    );
  }

  if (active === 'inbox') {
    return <InboxPanel companySessionId={sessionId} />;
  }

  if (active === 'env') {
    return <EnvTab companySessionId={sessionId} />;
  }

  return <DatabasesTab companySessionId={sessionId} />;
}

/**
 * Embedded preview pane for the agents view.
 *
 * Reuses the builder's `PreviewIframe` (toolbar + iframe + status
 * overlays + service switcher + log tail) so any improvement to the
 * iframe lands in both surfaces at once. The sidebar mounts at the
 * RIGHT of `CompanySessionView` whenever the session has a builder
 * sandbox configured. Sub-sessions (fronts) share the parent's
 * sandbox, so the consumer passes the ROOT session id — the inner
 * `useSandboxStatus` and `useExtraServices` hooks resolve everything
 * else against that id.
 *
 * Phase 3 keeps the iframe scope tight: just the preview. The other
 * builder tabs (Files / Git / API Reference) already live in
 * `BuildZone`; mounting them inside this sidebar would duplicate the
 * surface and confuse navigation.
 */
import { selectSandbox, useCompanyStore } from '../../../state/company/index.js';
import { PreviewIframe } from '../../builder/preview/preview-iframe/PreviewIframe.js';
import { useSandboxStatus } from '../../builder/useSandboxStatus.js';
import { useExtraServices } from './useExtraServices.js';

interface PreviewSidebarProps {
  /** Root session id — the one that owns the sandbox (parent for sub-sessions). */
  sessionId: number;
}

export function PreviewSidebar({ sessionId }: PreviewSidebarProps) {
  const { data, refresh, retry, restartDev } = useSandboxStatus(sessionId);
  const extraServices = useExtraServices(sessionId);

  // Hot-reload trigger: when the agent writes a file inside the sandbox
  // the SSE event lands in `sandboxSlice.lastFileChange.seq`. Forwarding
  // it via `fileChangeTick` makes `PreviewIframe` reload the iframe.
  const fileChangeTick = useCompanyStore(
    (s) => selectSandbox(s, sessionId).lastFileChange?.seq ?? 0,
  );

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

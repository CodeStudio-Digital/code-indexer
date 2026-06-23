/**
 * Tab wrapper that wires the existing builder-mode ApiReferenceTab into
 * the company/agents view. Keeping a single underlying renderer means
 * Scalar-side improvements land in both places at once.
 *
 * Phase 2: openapi invalidation reads from `sandboxSlice.lastFileChange`
 * instead of the legacy `window.dispatchEvent('sandbox:file-changed:N')`
 * bridge. The slice is updated by `useCompanyStream` when an SSE
 * `sandbox.file_changed` arrives, so the tab refetches the spec as soon
 * as the agent writes a new `openapi.{yaml,json}` — no polling, no DOM
 * custom events.
 *
 * The services-list poll (4 s) stays for now: there's no SSE channel
 * for service lifecycle yet. Phase 4 will add events for service
 * provisioning/teardown and this poll can be retired.
 */
import { ApiReferenceTab } from '../builder/preview/api-reference/ApiReferenceTab.js';
import { useSandboxStatus } from '../builder/useSandboxStatus.js';
import { selectSandbox, useCompanyStore } from '../../state/company/index.js';
import { useExtraServices } from './preview-sidebar/useExtraServices.js';

interface CompanyApiReferenceTabProps {
  sessionId: number;
}

export function CompanyApiReferenceTab({ sessionId }: CompanyApiReferenceTabProps) {
  const { data } = useSandboxStatus(sessionId);
  const extraServices = useExtraServices(sessionId);

  // SSE-driven OpenAPI refresh: bump the tick whenever the sandbox slice
  // records a new file change for this session. `seq` is monotonic so
  // forwarding it through to `ApiReferenceTab.fileChangeTick` causes a
  // re-fetch of the spec without redundant intermediate state.
  const lastFileChangeSeq = useCompanyStore(
    (s) => selectSandbox(s, sessionId).lastFileChange?.seq ?? 0,
  );

  return (
    <ApiReferenceTab
      sessionId={sessionId}
      snapshot={data}
      extraServices={extraServices}
      fileChangeTick={lastFileChangeSeq}
    />
  );
}

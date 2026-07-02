/**
 * Stacked session banners (connection phase, master-ended notice, stall
 * nudge, fatal error) rendered above the zone content. Extracted from
 * CompanySessionView so the shell stays lean; the fatal-error banner
 * suppresses the (now redundant) connection strip.
 */
import { AlertCircle } from 'lucide-react';
import type { useCompanyStream } from '../../../hooks/useCompanyStream.js';
import { ConnectionPhaseStrip } from '../ConnectionPhaseStrip.js';
import { MasterStatusBanner } from '../MasterStatusBanner.js';
import { SessionStalledBanner } from '../SessionStalledBanner.js';
import { AutonomyIncidentBanner } from './AutonomyIncidentBanner.js';

export function SessionBanners({
  stream,
  sessionId = null,
}: {
  stream: ReturnType<typeof useCompanyStream>;
  /** C1 — needed by the autonomy incident banner; optional for older call-sites. */
  sessionId?: number | null;
}) {
  return (
    <>
      {!stream.error && <ConnectionPhaseStrip phase={stream.connectionPhase} />}
      {stream.error && (
        <div className="mx-3 mt-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>{stream.error}</p>
        </div>
      )}

      {/* C1 — severe supervisor incidents (quarantine / ghost / read-only). */}
      <AutonomyIncidentBanner sessionId={sessionId} />

      <MasterStatusBanner
        endedAt={stream.masterEndedAt}
        unexpected={stream.masterEndedUnexpected}
        errorDetail={stream.masterErrorDetail}
      />

      <SessionStalledBanner
        stalledSinceMs={stream.sessionStalledSinceMs}
        onContinue={async () => {
          // Triple-prong wake-up because a stall can be in any of:
          //   (a) interactive wait (ask_user/submit_plan) — needs
          //       interject:true on the sendMessage to break the
          //       wait before the new message gets queued.
          //   (b) master ended/paused with pending inbox — needs
          //       the wake-master endpoint to forward the queued
          //       inbox row through the in-process router.
          //   (c) runner alive but hung mid-tool — both above are
          //       no-ops, but at least the message is recorded for
          //       when the user manually resets.
          // Order: send first (so the message is on the board even
          // if wake fails), then wake (idempotent — safe to spam).
          await stream.sendMessage(
            '[SYSTEM] Status check — any blockers? Update the board with current progress and pick up the next task.',
            [],
            { interject: true },
          );
          await stream.wakeMaster();
        }}
      />
    </>
  );
}

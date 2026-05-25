/**
 * MasterPhaseIndicator — renders one of five visual phases for the
 * company session's master, replacing the legacy binary "loader OR
 * nothing" surface. Drives a clear conversation between the
 * dashboard and the operator:
 *
 *   - `starting`        spinner + "Iniciando agente Master" while the
 *                       runner boots. Same loader as before.
 *   - `idle_pending`    amber pill + "Acordar Master agora" button
 *                       when the master is dead but inbox messages
 *                       are waiting. The wake button POSTs to
 *                       /wake-master and forwards to the inbox
 *                       router (idempotent + atomic claim).
 *   - `idle_paused`     muted "Master em standby" pill — clean idle
 *                       state, user can send a fresh message to
 *                       resume.
 *   - `error`           rendered when the master ended with an error.
 *                       The existing MasterCompletionBanner already
 *                       covers the detail page; we just stay quiet
 *                       here to avoid duplicate noise.
 *   - `running`         (no render) the regular transcript takes
 *                       over.
 *
 * Phase derivation is pure: callers pass in raw stream fields and we
 * pick the right state. Keeps tests trivial.
 */
import { RefreshCw, AlertTriangle, Moon, Bell } from 'lucide-react';
import type { AgentStreamState } from '../../../state/company/types.js';
import { Button } from '../../../components/ui/button.js';

interface Props {
  started: boolean;
  masterState: AgentStreamState | null;
  error: string | null;
  /** Liveness from /state-snapshot — defaults true so first render is quiet. */
  masterAlive: boolean;
  pendingMasterInboxCount: number;
  onWakeMaster: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}

type Phase = 'starting' | 'idle_pending' | 'idle_paused' | 'hidden';

function derivePhase(p: Props): Phase {
  if (p.error) return 'hidden';
  // Master not alive yet but the optimistic `started` flag was set —
  // we're booting. Show the spinner.
  if (p.started && !p.masterState) return 'starting';
  // Alive (running or has a transcript surface): let the regular UI take over.
  if (p.masterAlive) return 'hidden';
  // Dead but inbox pending → wake CTA.
  if (p.pendingMasterInboxCount > 0) return 'idle_pending';
  // Dead and inbox empty → standby.
  return 'idle_paused';
}

export function MasterPhaseIndicator(props: Props) {
  const phase = derivePhase(props);
  if (phase === 'hidden') return null;

  if (phase === 'starting') {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">
          {props.t('company.startingMaster')}
        </span>
      </div>
    );
  }

  if (phase === 'idle_paused') {
    return (
      <div className="flex items-center justify-center py-6">
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <Moon className="h-3.5 w-3.5" />
          <span>{props.t('company.masterIdle.standby')}</span>
        </div>
      </div>
    );
  }

  // idle_pending
  return (
    <div className="flex items-center justify-center py-6">
      <div className="inline-flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          {props.t('company.masterIdle.pendingInbox', { count: props.pendingMasterInboxCount })}
        </span>
        <Button size="sm" variant="outline" onClick={props.onWakeMaster}>
          <Bell className="h-3.5 w-3.5 mr-1.5" />
          {props.t('company.actions.wakeMaster')}
        </Button>
      </div>
    </div>
  );
}

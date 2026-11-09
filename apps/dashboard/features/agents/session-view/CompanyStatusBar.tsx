/**
 * CompanyStatusBar — single-line footer between the board area and the
 * composer. Replaces the bulky `MasterPhaseIndicator` block with an IDE-
 * style status strip: master state at the left, contextual counters in
 * the middle, primary action at the right.
 *
 * Visual conventions:
 *   - 20px tall (shared `StatusBarShell`), hairline top border, muted
 *     background so it doesn't fight the transcript or composer for
 *     attention — identical to the ProjectView status bar.
 *   - Left: master state pill (running / standby / pending / error).
 *     One-word label + tiny icon; no spinner — when the master is
 *     actively running, the transcript is already rendering text/tool
 *     calls so a spinner here would be redundant.
 *   - Middle: subordinate count + pending inbox count. Hidden when both
 *     are zero so the bar stays quiet during empty sessions.
 *   - Right: when pendingInbox > 0 and the master isn't alive, the
 *     "Acordar Master" button surfaces here — same affordance as the
 *     previous block, but inline.
 *
 * Phase derivation is identical to the previous indicator (running /
 * starting / idle_pending / idle_paused / error) — we just render
 * each phase as a pill in the strip instead of a centered block.
 */
import { Loader2, Moon, Activity, AlertTriangle, Bell, AlertCircle } from 'lucide-react';
import type { AgentStreamState } from '../../../state/company/types.js';
import { StatusBarShell } from '../../../components/chrome/index.js';
import { cn } from '../../../lib/utils.js';

interface Props {
  started: boolean;
  masterState: AgentStreamState | null;
  error: string | null;
  masterAlive: boolean;
  pendingMasterInboxCount: number;
  /** Number of subordinates currently in the session — surfaces in the middle slot. */
  subordinateCount: number;
  /** Number of subordinates whose status is 'running' or 'waiting_*'. */
  activeSubordinateCount: number;
  onWakeMaster?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}

type Phase = 'running' | 'starting' | 'idle_pending' | 'idle_paused' | 'error';

function derivePhase(p: Props): Phase {
  if (p.error) return 'error';
  if (p.masterAlive) return 'running';
  if (p.pendingMasterInboxCount > 0) return 'idle_pending';
  return 'idle_paused';
}

interface PhaseStyle {
  icon: typeof Loader2;
  label: string;
  className: string;
  iconClassName?: string;
}

function phaseStyle(phase: Phase, p: Props): PhaseStyle {
  switch (phase) {
    case 'running':
      return {
        icon: Activity,
        label: p.t('company.phase.running', 'Master ativo'),
        className: 'text-emerald-600 dark:text-emerald-400',
      };
    case 'starting':
      return {
        icon: Loader2,
        label: p.t('company.startingMaster'),
        className: 'text-muted-foreground',
        iconClassName: 'animate-spin',
      };
    case 'idle_pending':
      return {
        icon: AlertTriangle,
        label: p.t('company.phase.idlePending', 'Master parado com inbox pendente'),
        className: 'text-amber-600 dark:text-amber-400',
      };
    case 'idle_paused':
      return {
        icon: Moon,
        label: p.t('company.masterIdle.standby'),
        className: 'text-muted-foreground',
      };
    case 'error':
      return {
        icon: AlertCircle,
        label: p.t('company.phase.error', 'Master com erro'),
        className: 'text-destructive',
      };
  }
}

export function CompanyStatusBar(props: Props) {
  const phase = derivePhase(props);
  const style = phaseStyle(phase, props);
  const Icon = style.icon;

  const showCounters =
    props.subordinateCount > 0 ||
    props.pendingMasterInboxCount > 0;

  return (
    <StatusBarShell>
      {/* Left — phase pill */}
      <div className={cn('flex items-center gap-1.5 shrink-0', style.className)}>
        <Icon className={cn('h-3 w-3 shrink-0', style.iconClassName)} />
        <span className="truncate">{style.label}</span>
      </div>

      <span className="w-px h-3 bg-border" aria-hidden />

      {/* Middle — counters. Spacing collapses cleanly when both are 0. */}
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {showCounters && (
          <>
            <span className="truncate">
              {props.activeSubordinateCount}/{props.subordinateCount}{' '}
              {props.t('company.statusBar.subs', 'agentes ativos')}
            </span>
            {props.pendingMasterInboxCount > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {props.t('company.statusBar.pendingInbox', '{{count}} aguardando', {
                  count: props.pendingMasterInboxCount,
                })}
              </span>
            )}
          </>
        )}
      </div>

      {/* Right — wake action as a status chip (fits the 20px bar, mirrors
          the ProjectView status-bar chips). */}
      {phase === 'idle_pending' && props.onWakeMaster && (
        <button
          type="button"
          onClick={props.onWakeMaster}
          className="inline-flex items-center gap-1 rounded px-1.5 -mx-0.5 text-amber-600 dark:text-amber-400 hover:bg-muted/40 transition-colors"
        >
          <Bell className="h-3 w-3" />
          {props.t('company.actions.wakeMaster')}
        </button>
      )}
    </StatusBarShell>
  );
}

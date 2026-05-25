/**
 * CompanyStatusBar — single-line footer between the board area and the
 * composer. Replaces the bulky `MasterPhaseIndicator` block with an IDE-
 * style status strip: master state at the left, contextual counters in
 * the middle, primary action at the right.
 *
 * Visual conventions:
 *   - 28px tall, top + bottom border, muted background so it doesn't
 *     fight the transcript or the composer for attention.
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
import { Button } from '../../../components/ui/button.js';
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
  onWakeMaster: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}

type Phase = 'running' | 'starting' | 'idle_pending' | 'idle_paused' | 'error';

function derivePhase(p: Props): Phase {
  if (p.error) return 'error';
  if (p.started && !p.masterState) return 'starting';
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
    <div className="shrink-0 h-7 border-t bg-card/60 px-3 flex items-center gap-3 text-[11.5px]">
      {/* Left — phase pill */}
      <div className={cn('flex items-center gap-1.5 shrink-0', style.className)}>
        <Icon className={cn('h-3.5 w-3.5 shrink-0', style.iconClassName)} />
        <span className="truncate">{style.label}</span>
      </div>

      <span className="w-px h-3 bg-border" aria-hidden />

      {/* Middle — counters. Spacing collapses cleanly when both are 0. */}
      <div className="flex items-center gap-3 text-muted-foreground min-w-0 flex-1">
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

      {/* Right — wake action when relevant */}
      {phase === 'idle_pending' && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[11px] px-2"
          onClick={props.onWakeMaster}
        >
          <Bell className="h-3 w-3 mr-1.5" />
          {props.t('company.actions.wakeMaster')}
        </Button>
      )}
    </div>
  );
}

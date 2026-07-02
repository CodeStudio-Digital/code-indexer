/**
 * Single row in the services sidebar. Renders:
 *   - Name + stack chip + status/role badges (main / orphaned /
 *     external / attached).
 *   - Status text (color-coded) + "open" preview link.
 *   - Action buttons: pause/play, restart-dev, retry, refresh
 *     (attached only), remove.
 *
 * Action handlers + busy-id state come from `useServiceActions` via
 * props — this component is pure render given the `ServiceRow` and the
 * action hook's return value.
 *
 * Extracted from the inline `services.map((svc) => …)` block in the
 * original ServicesSidebar. Pulled out so the sidebar coordinator
 * stays focused on layout (header, list, error, add-form slot).
 */

import { useTranslation } from 'react-i18next';
import { ChevronDown, Pause, Play, RefreshCw, RotateCw, Trash2, Zap } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { formatUptime, healthDotClassName, statusClassName, type ServiceRow } from './types.js';
import type { UseServiceActionsResult } from './useServiceActions.js';

export interface ServiceListItemProps {
  svc: ServiceRow;
  actions: UseServiceActionsResult;
  /** B6 — logs+timeline detail expansion. Optional: legacy mounts omit it. */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

export function ServiceListItem({ svc, actions, expanded, onToggleExpand }: ServiceListItemProps) {
  const { t } = useTranslation('agents');
  const {
    restartingId,
    runtimePausingId,
    startingId,
    refreshingId,
    removeService,
    restartServiceDev,
    setRuntimePaused,
    refreshAttachedService,
    startOrPromptStack,
    retryService,
    retryPrimary,
    retryOrphanedService,
    stopLocalProject,
  } = actions;

  const isOrphaned = svc.status === 'orphaned';
  const isAttached = !!svc.is_attached;
  // B8 — host-process row (`local:<id>`). No container to pause/restart/
  // retry: the only action is Stop (DELETE /local-project) on the Trash
  // slot. Health arrives via the SSE overlay (see ServicesSidebar).
  const isLocal = svc.kind === 'local' || svc.stack === 'local-process';
  const runtimePaused = !!svc.runtime_paused;
  const displayStatus = runtimePaused ? 'paused' : svc.status;
  const isManagedContainer =
    svc.stack !== 'local-process' && !isOrphaned && !isAttached;
  const canPauseRuntime =
    isManagedContainer &&
    (runtimePaused || svc.status === 'ready' || svc.status === 'running');
  const canStart =
    !isAttached &&
    svc.stack !== 'local-process' &&
    (isOrphaned || svc.status === 'paused' || svc.status === 'error');
  const actionBusy =
    runtimePausingId === svc.service_id || startingId === svc.service_id;
  const showPlay = runtimePaused || canStart;

  return (
    <div
      className={
        'rounded border p-1.5 flex items-center gap-2 text-[10px] ' +
        (svc.is_primary
          ? 'border-primary/40 bg-primary/5'
          : isOrphaned
            ? 'border-amber-500/40 bg-amber-500/5'
            : '')
      }
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="font-medium truncate">{svc.name || svc.service_id}</span>
          {svc.stack && (
            <span className="text-muted-foreground text-[9px]">({svc.stack})</span>
          )}
          {svc.is_primary && (
            <span
              className="text-[8px] uppercase tracking-wide rounded px-1 bg-primary/15 text-primary"
              title="Primary container for this session"
            >
              main
            </span>
          )}
          {isLocal && (
            <span
              className="text-[8px] uppercase tracking-wide rounded px-1 bg-teal-500/15 text-teal-600"
              title={t('services.local.tooltip')}
            >
              {t('services.local.badge')}
            </span>
          )}
          {isOrphaned && !svc.is_primary && (
            <span
              className="text-[8px] uppercase tracking-wide rounded px-1 bg-amber-500/15 text-amber-600"
              title={
                svc.root_path
                  ? `Container gone. Files still at ${svc.root_path}`
                  : 'Container gone — retry to re-provision.'
              }
            >
              orphaned
            </span>
          )}
          {svc.mount_kind === 'external' && !isAttached && !isLocal && (
            <span
              className="text-[8px] uppercase tracking-wide rounded px-1 bg-sky-500/15 text-sky-600"
              title="External project files are preserved on delete"
            >
              {t('services.external.badge')}
            </span>
          )}
          {isAttached && (
            <span
              className="text-[8px] uppercase tracking-wide rounded px-1 bg-violet-500/15 text-violet-600"
              title={
                svc.external_container_ref
                  ? `External container '${svc.external_container_ref}' (managed outside the platform)`
                  : 'Externally-managed container'
              }
            >
              {t('services.attached.badge')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span
            className={'inline-block h-1.5 w-1.5 rounded-full shrink-0 ' + healthDotClassName(svc.health)}
            title={
              t(`services.health.${svc.health ?? 'unknown'}`, { defaultValue: svc.health ?? 'unknown' }) +
              (svc.health_detail ? ` — ${svc.health_detail}` : '')
            }
          />
          <span className={statusClassName(displayStatus)}>{displayStatus}</span>
          {formatUptime(svc.started_at_ms) !== '' &&
            (displayStatus === 'ready' || displayStatus === 'running') && (
              <span title={t('services.uptimeTooltip')}>
                {t('services.uptime', { time: formatUptime(svc.started_at_ms) })}
              </span>
            )}
          {(svc.restart_count ?? 0) > 0 && (
            <span title={t('services.restartsTooltip', { n: svc.restart_count ?? 0 })}>
              ↻{svc.restart_count}
            </span>
          )}
          {svc.preview_url && (
            <a
              href={svc.preview_url}
              target="_blank"
              rel="noreferrer"
              className="underline truncate"
            >
              open
            </a>
          )}
        </div>
        {svc.error && (
          <div className="text-[9px] text-red-500 truncate" title={svc.error}>
            {svc.error}
          </div>
        )}
      </div>
      {onToggleExpand && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onToggleExpand}
          title={expanded ? t('services.detail.collapse') : t('services.detail.expand')}
        >
          <ChevronDown
            className={'h-3 w-3 transition-transform ' + (expanded ? 'rotate-180' : '')}
          />
        </Button>
      )}
      {isAttached && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={() => void refreshAttachedService(svc.service_id)}
          disabled={refreshingId === svc.service_id}
          title={t('services.attached.refreshTooltip')}
        >
          <RefreshCw
            className={'h-3 w-3 ' + (refreshingId === svc.service_id ? 'animate-spin' : '')}
          />
        </Button>
      )}
      {!isAttached && !isLocal && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => {
              if (runtimePaused) {
                void setRuntimePaused(svc.service_id, false);
                return;
              }
              if (canStart) {
                void startOrPromptStack(svc);
                return;
              }
              void setRuntimePaused(svc.service_id, true);
            }}
            disabled={
              actionBusy ||
              (!canPauseRuntime && !canStart) ||
              svc.status === 'pending' ||
              svc.status === 'provisioning' ||
              svc.status === 'destroying'
            }
            title={
              svc.stack === 'local-process'
                ? 'Host process cannot be controlled with Podman'
                : runtimePaused
                  ? 'Unpause container'
                  : canStart
                    ? 'Start container'
                    : isOrphaned
                      ? 'No container to pause'
                      : canPauseRuntime
                        ? 'Pause container'
                        : 'Container is not ready'
            }
          >
            {showPlay ? (
              <Play className={'h-3 w-3 ' + (actionBusy ? 'animate-pulse' : '')} />
            ) : (
              <Pause className={'h-3 w-3 ' + (actionBusy ? 'animate-pulse' : '')} />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => void restartServiceDev(svc.service_id)}
            disabled={
              restartingId === svc.service_id || svc.is_primary || isOrphaned || runtimePaused
            }
            title={
              svc.is_primary
                ? 'Primary dev-server is managed by the session lifecycle'
                : isOrphaned
                  ? 'No container to restart — use Retry instead'
                  : runtimePaused
                    ? 'Unpause container before restarting dev-server'
                    : 'Restart dev-server (keeps files, relaunches process)'
            }
          >
            <Zap
              className={'h-3 w-3 ' + (restartingId === svc.service_id ? 'animate-pulse' : '')}
            />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => {
              if (svc.is_primary) {
                if (
                  !confirm(
                    `Retry the primary container? The current sandbox will be torn down and rebuilt from the same stack and bind-mount — your files on disk are preserved.`,
                  )
                ) {
                  return;
                }
                void retryPrimary();
                return;
              }
              if (isOrphaned && !svc.stack) {
                void retryOrphanedService(svc.service_id);
                return;
              }
              void retryService(svc.service_id);
            }}
            title={
              svc.is_primary
                ? 'Retry primary container provision (tears down and rebuilds — files kept)'
                : isOrphaned
                  ? 'Re-provision this service (you will be asked for the stack)'
                  : 'Retry provision'
            }
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-5 w-5"
        onClick={() => void (isLocal ? stopLocalProject() : removeService(svc.service_id))}
        disabled={svc.is_primary}
        title={
          isLocal
            ? t('services.local.stopTooltip')
            : svc.is_primary
              ? 'Primary container cannot be removed from this panel'
              : isOrphaned
                ? svc.mount_kind === 'external'
                  ? 'Drop the orphaned project link; files are preserved'
                  : 'Drop the orphaned project link and delete its files'
                : 'Remove service'
        }
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

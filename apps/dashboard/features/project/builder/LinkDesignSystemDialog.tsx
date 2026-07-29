/**
 * "Link design system" — top-bar affordance for Builder projects. Lists the
 * published DSs (incompatible stacks shown disabled with the reason), links/
 * updates/unlinks via POST/DELETE /api/projects/:id/design-system/link, and
 * surfaces the pinned version + a subtle "newer available" hint. Renders
 * nothing for non-builder projects and DS Studio workspaces.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Palette, Unlink } from 'lucide-react';
import type { Project } from '@mcp/shared/types.js';
import { Button } from '../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';
import { useApi, apiPost, apiDelete } from '../../../hooks/useApi.js';
import {
  isNewerSemver,
  useLinkableDesignSystems,
  type LinkableDs,
} from '../new-project/useLinkableDesignSystems.js';

interface DsLinkInfo {
  sessionId: string;
  packageName: string;
  semver: string;
}

/** Builder config relevant here; null for non-builder or DS workspaces. */
function parseBuilder(json: string | null | undefined): { stack: string; designSystem: DsLinkInfo | null } | null {
  if (!json) return null;
  try {
    const cfg = JSON.parse(json) as { stack?: string; kind?: string; designSystem?: Partial<DsLinkInfo> };
    if (cfg.kind === 'ds' || typeof cfg.stack !== 'string') return null;
    const ds = cfg.designSystem;
    const linked =
      ds && typeof ds.sessionId === 'string' && typeof ds.packageName === 'string' && typeof ds.semver === 'string'
        ? { sessionId: ds.sessionId, packageName: ds.packageName, semver: ds.semver }
        : null;
    return { stack: cfg.stack, designSystem: linked };
  } catch {
    return null;
  }
}

export function LinkDesignSystemDialog({ projectId }: { projectId: number }) {
  const { t } = useTranslation(['projects', 'common']);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: project, refetch } = useApi<Project>(`/projects/${projectId}`);
  const cfg = useMemo(() => parseBuilder(project?.builder_json), [project?.builder_json]);
  const ds = useLinkableDesignSystems(cfg?.stack ?? 'react-ts', open && !!cfg);

  if (!cfg) return null;
  const linked = cfg.designSystem;
  const linkedEntry = linked ? ds.items.find((d) => d.sessionId === linked.sessionId) ?? null : null;

  async function run(key: string | 'unlink', action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const link = (d: LinkableDs) =>
    run(d.sessionId, () => apiPost(`/projects/${projectId}/design-system/link`, { ds_session_id: d.sessionId }));
  const unlink = () => run('unlink', () => apiDelete(`/projects/${projectId}/design-system/link`));

  function rowAction(d: LinkableDs) {
    const isLinkedRow = linked?.sessionId === d.sessionId;
    const updatable = isLinkedRow && linked && isNewerSemver(d.semver, linked.semver);
    if (isLinkedRow && !updatable) {
      return (
        <Button size="sm" variant="outline" disabled>
          <Check className="h-3.5 w-3.5" /> {t('dsLink.linked', 'Linked')}
        </Button>
      );
    }
    return (
      <Button size="sm" disabled={!d.compatible || busy !== null} onClick={() => void link(d)}>
        {busy === d.sessionId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {updatable ? t('dsLink.update', 'Update to v{{semver}}', { semver: d.semver }) : t('dsLink.link', 'Link')}
      </Button>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(true)}
            aria-label={t('dsLink.tooltip', 'Link a design system')}
          >
            <Palette className={`h-3.5 w-3.5 ${linked ? 'text-indigo-500' : ''}`} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {linked ? `${linked.packageName}@${linked.semver}` : t('dsLink.tooltip', 'Link a design system')}
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('dsLink.title', 'Design system')}</DialogTitle>
            <DialogDescription>
              {t('dsLink.description', 'Install a design system published in the DS Studio and the agent will build UI with its components first.')}
            </DialogDescription>
          </DialogHeader>

          {linked && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-mono">{linked.packageName}@{linked.semver}</span>
              {linkedEntry && isNewerSemver(linkedEntry.semver, linked.semver) && (
                <span className="ml-2 text-xs text-indigo-500">
                  {t('dsLink.updateAvailable', 'v{{semver}} available', { semver: linkedEntry.semver })}
                </span>
              )}
              {!linkedEntry && !ds.loading && (
                <span className="ml-2 text-xs text-amber-600">
                  {t('dsLink.stale', 'session no longer exists — unlink or publish it again')}
                </span>
              )}
            </div>
          )}

          <div className="max-h-64 space-y-2 overflow-y-auto">
            {ds.loading ? (
              <p className="text-sm text-muted-foreground">{t('wizard.dsLoading', 'Loading design systems…')}</p>
            ) : ds.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('dsLink.empty', 'No published design system yet — create one in the DS Studio.')}
              </p>
            ) : (
              ds.items.map((d) => (
                <div key={d.sessionId} className={`flex items-center gap-3 rounded-md border px-3 py-2 ${d.compatible ? '' : 'opacity-60'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {d.packageName}@{d.semver}
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">{d.stack}</span>
                      {!d.compatible && (
                        <span className="ml-2 text-[10px] text-amber-600">
                          {t('wizard.dsIncompatible', 'incompatible stack ({{stack}})', { stack: d.stack })}
                        </span>
                      )}
                    </div>
                  </div>
                  {rowAction(d)}
                </div>
              ))
            )}
          </div>

          {(error || ds.error) && <p className="text-xs text-destructive">{error ?? ds.error}</p>}

          <DialogFooter>
            {linked && (
              <Button variant="outline" onClick={() => void unlink()} disabled={busy !== null}>
                {busy === 'unlink' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
                {t('dsLink.unlink', 'Unlink')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common:actions.close', { defaultValue: 'Close' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

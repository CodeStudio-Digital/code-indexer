/**
 * Aba "Seu app" — o ProjectPreview (visual-edit/click-to-select do
 * Builder) com o runner automático por baixo: enquanto o dev server sobe,
 * um skeleton amigável ("Preparando seu app…"); depois, o preview vivo.
 */
import { useTranslation } from 'react-i18next';
import { Loader2, MousePointerClick } from 'lucide-react';
import { ProjectPreview } from '../../project/builder/ProjectPreview.js';
import { useAutoDevServer } from './useAutoDevServer.js';

export function AppPreviewPanel({
  projectId,
  builderPort,
  onHide,
}: {
  projectId: number;
  builderPort: number | null;
  onHide?: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const { status, url } = useAutoDevServer(projectId, builderPort ?? undefined);

  if (status !== 'running' || !url) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-card p-6 text-center">
        <div className="w-full max-w-md space-y-2 rounded-lg border p-3">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-muted" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted" />
            <div className="ml-2 h-4 flex-1 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-24 animate-pulse rounded bg-muted/70" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('preview.preparing')}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b bg-muted/20 px-2 text-[11px] text-muted-foreground">
        <MousePointerClick className="h-3 w-3" /> {t('preview.hint')}
      </div>
      <div className="min-h-0 flex-1">
        <ProjectPreview key={projectId} projectId={projectId} pinnedPort={builderPort ?? undefined} selectionEnabled onHide={onHide} />
      </div>
    </div>
  );
}

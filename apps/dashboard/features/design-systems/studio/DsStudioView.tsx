/**
 * DS Studio — a tela do Design System guiado: chat (sessão single com o
 * agente builder) | preview ao vivo da galeria (seleção de elementos,
 * problems feed) | rail de Versões/Componentes/Docs. Tudo keyed pelo
 * projeto-workspace; o botão Publicar manda uma mensagem pré-pronta no
 * chat (humano no loop — o agente roda audit → fix → publish).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowLeft, Loader2, Rocket } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import AgentChat from '../../chat/index.js';
import { ProjectPreview } from '../../project/builder/ProjectPreview.js';
import { requestStudioSend } from '../../builder/studio/studio-context-store.js';
import {
  getDesignSystemSession,
  type DesignSystemSessionDetail,
} from '../design-system-api.js';
import { DsStudioRail } from './DsStudioRail.js';

const REFRESH_INTERVAL_MS = 5_000;

export function DsStudioView({
  dsSessionId,
  initialCoderSessionId,
  onBack,
}: {
  dsSessionId: number;
  /** Setado logo após a criação para abrir a sessão de chat recém-criada. */
  initialCoderSessionId?: number;
  onBack: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const [detail, setDetail] = useState<DesignSystemSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getDesignSystemSession(dsSessionId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [dsSessionId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (error && !detail) {
    return (
      <div className="space-y-3 p-6 text-sm">
        <div className="rounded border border-red-300 bg-red-50 p-3 text-red-800">{error}</div>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {t('actions.allSessions')}
        </Button>
      </div>
    );
  }
  if (!detail || !detail.project) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('session.loading')}
      </div>
    );
  }

  const { session, project, builder_port: builderPort, latest_published: latestPublished } = detail;
  const projectId = project.id;

  function publish() {
    requestStudioSend(projectId, t('studio.publishMessage'));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> {t('actions.allSessions')}
        </Button>
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{session.name}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {session.package_name}
            {latestPublished ? `@${latestPublished.semver}` : ` · ${t('studio.unpublished')}`}
            {' · '}{session.stack}
          </span>
        </div>
        {error && <span className="truncate text-xs text-red-600">{error}</span>}
        <Button size="sm" onClick={publish} title={t('studio.publishTitle')}>
          <Rocket className="mr-1 h-3.5 w-3.5" /> {t('studio.publish')}
        </Button>
      </header>

      <PanelGroup direction="horizontal" autoSaveId="mcp-ds-studio-horiz" className="min-h-0 flex-1">
        <Panel id="ds-chat" order={1} defaultSize={40} minSize={26}>
          <AgentChat
            projectId={projectId}
            projectName={project.name}
            initialSessionId={initialCoderSessionId}
            selectionPrefixSessionId={projectId}
          />
        </Panel>
        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
        <Panel id="ds-preview" order={2} defaultSize={38} minSize={24}>
          <ProjectPreview
            projectId={projectId}
            pinnedPort={builderPort ?? undefined}
            selectionEnabled={session.stack === 'react-ts'}
          />
        </Panel>
        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
        <Panel id="ds-rail" order={3} defaultSize={22} minSize={14}>
          <DsStudioRail detail={detail} onChanged={() => void refresh()} />
        </Panel>
      </PanelGroup>
    </div>
  );
}

import { ListChecks, MessageSquareCode, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RailButton, RailContainer } from '../../components/chrome/index.js';
import type { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { EditorChatRail } from '../project/editor-chat/EditorChatRail.js';
import { AppStudioChatRail } from './AppStudioChatRail.js';
import { AppTeamPanel } from './team/AppTeamPanel.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';

export type AppStudioSidePanel = 'chat' | 'sessions' | 'team';

export function AppStudioRightRail({ active, onToggle }: { active: AppStudioSidePanel | null; onToggle: (panel: AppStudioSidePanel) => void }) {
  const { t } = useTranslation('appStudio');
  return (
    <RailContainer side="right" aria-label={t('v6.team.railLabel')}>
      <RailButton icon={ListChecks} label={t('v6.orchestration.railButton')} side="right" role="toggle" active={active === 'chat'} onClick={() => onToggle('chat')} />
      <RailButton icon={MessageSquareCode} label={t('v6.sessions.railButton')} side="right" role="toggle" active={active === 'sessions'} onClick={() => onToggle('sessions')} />
      <RailButton icon={Users} label={t('v6.team.railButton')} side="right" role="toggle" active={active === 'team'} onClick={() => onToggle('team')} />
    </RailContainer>
  );
}

export function AppStudioRightPanel({
  active,
  appSessionId,
  companySessionId,
  projectId,
  projectName,
  masterSessionId,
  initialPrompt,
  detail,
  singleSessionId,
  onSingleSessionChange,
  companyStream,
  onChanged,
  onCollapse,
}: {
  active: AppStudioSidePanel;
  appSessionId: number;
  companySessionId: number | null;
  projectId: number;
  projectName: string;
  masterSessionId: number | null;
  initialPrompt?: string | null;
  detail: AppStudioSessionDetail;
  singleSessionId?: number | null;
  onSingleSessionChange?: (sessionId: number | null) => void;
  companyStream: ReturnType<typeof useCompanyStream>;
  onChanged: () => void;
  onCollapse?: () => void;
}) {
  if (active === 'team') return <AppTeamPanel appSessionId={appSessionId} onCollapse={onCollapse} />;
  if (active === 'sessions') {
    return (
      <AppStudioSessionsPanel
        projectId={projectId}
        projectName={projectName}
        initialSessionId={singleSessionId}
        onSessionChange={onSingleSessionChange}
        onCollapse={onCollapse}
      />
    );
  }
  return <AppStudioChatRail appSessionId={appSessionId} companySessionId={companySessionId} projectId={projectId} projectName={projectName} masterSessionId={masterSessionId} initialPrompt={initialPrompt} detail={detail} companyStream={companyStream} onChanged={onChanged} onCollapse={onCollapse} />;
}

function AppStudioSessionsPanel({
  projectId,
  projectName,
  initialSessionId,
  onSessionChange,
  onCollapse,
}: {
  projectId: number;
  projectName: string;
  initialSessionId?: number | null;
  onSessionChange?: (sessionId: number | null) => void;
  onCollapse?: () => void;
}) {
  const { t } = useTranslation('appStudio');
  return (
    <EditorChatRail
      projectId={projectId}
      projectName={projectName}
      onClose={() => onCollapse?.()}
      initialSessionId={initialSessionId}
      onSelectedSessionChange={onSessionChange}
      selectionPrefixSessionId={projectId}
      includeEditorContext={false}
      initialAgent="builder"
      newSessionTitle={t('v6.sessions.newTitle', { app: projectName })}
    />
  );
}

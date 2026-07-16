import { useEffect } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RailButton, RailContainer } from '../../components/chrome/index.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { AppStudioChatRail } from './AppStudioChatRail.js';

export type AppStudioSidePanel = 'chat';

export function AppStudioRightRail({ active, onToggle }: { active: AppStudioSidePanel | null; onToggle: (panel: AppStudioSidePanel) => void }) {
  const { t } = useTranslation('appStudio');
  return (
    <RailContainer side="right" aria-label={t('agentRail.chat', { defaultValue: 'Chat do coordenador' })}>
      <RailButton icon={MessageSquare} label={t('agentRail.chat', { defaultValue: 'Chat do coordenador' })} side="right" role="toggle" active={active === 'chat'} onClick={() => onToggle('chat')} />
    </RailContainer>
  );
}

export function AppStudioRightPanel({
  appSessionId,
  companySessionId,
  projectId,
  projectName,
  masterSessionId,
  initialPrompt,
  onCollapse,
}: {
  active: AppStudioSidePanel;
  appSessionId: number;
  companySessionId: number | null;
  projectId: number;
  projectName: string;
  masterSessionId: number | null;
  initialPrompt?: string | null;
  onCollapse?: () => void;
}) {
  const company = useCompanyStream(companySessionId, undefined, { kind: 'app_studio', appSessionId });
  useEffect(() => { if (companySessionId != null) void company.reattach(); }, [companySessionId, company.reattach]);
  return <AppStudioChatRail appSessionId={appSessionId} companySessionId={companySessionId} projectId={projectId} projectName={projectName} masterSessionId={masterSessionId} initialPrompt={initialPrompt} companyStream={company} onCollapse={onCollapse} />;
}

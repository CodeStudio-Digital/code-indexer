import { useTranslation } from 'react-i18next';
import { SessionDriveView } from '../SessionDrivePanel.js';
import { ProjectFilesSection } from '../sidebar/ProjectFilesSection.js';
import { SessionAttachments } from '../drive/SessionAttachments.js';
import { ConversationChaptersPanel } from '../messages/ConversationChapters.js';

export function SessionContextPanel(props: {
  sessionId: string; projectId: number | null; showChapters: boolean;
  sessionStatus?: string | null; fallbackSummary?: string | null;
  filePicks: string[]; revision?: string;
  onTogglePick: (path: string) => void;
  onSetManyPicks: (paths: string[], select: boolean) => void;
}) {
  const { t } = useTranslation('chat');
  return <SessionDriveView sessionId={props.sessionId} active initialTab={props.showChapters ? 'chapters' : 'attachments'}
    attachments={<>
      <p className="border-b px-3 py-2 text-xs text-muted-foreground">{t('context.attachmentsHint')}</p>
      <SessionAttachments sessionId={props.sessionId} revision={props.revision} />
      {props.projectId != null && <ProjectFilesSection sessionId={props.sessionId} projectId={props.projectId}
        selected={props.filePicks} onToggleSelect={props.onTogglePick} onSetMany={props.onSetManyPicks} />}
    </>}
    chapters={<ConversationChaptersPanel sessionId={props.sessionId} sessionStatus={props.sessionStatus} fallbackSummary={props.fallbackSummary} />} />;
}

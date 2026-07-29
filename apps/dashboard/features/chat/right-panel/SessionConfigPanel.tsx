/**
 * Tabbed "Configuration" body for the right rail — merges the per-session
 * Skills and Tools enable/disable surfaces (formerly two separate rail
 * icons) into one panel with two tabs. Mounted by `RightPanelHost` under
 * the `config` id, wrapped in `PanelChrome` (which provides the header +
 * close button) so this component only renders the tab strip + bodies.
 *
 * Both bodies are headless views reused as-is. Radix unmounts the inactive
 * tab, so switching tabs re-runs that view's fetch — same lifecycle as
 * reopening the old panel.
 */
import { useTranslation } from 'react-i18next';
import { Sparkles, Wrench } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.js';
import { SkillConfigView } from '../SkillConfigDialog.js';
import { ToolConfigView } from '../ToolConfigDialog.js';

export function SessionConfigView({
  sessionId,
  loadKey,
}: {
  sessionId: string | null;
  loadKey?: number;
}) {
  const { t } = useTranslation(['chat']);
  return (
    <Tabs defaultValue="skills" className="flex flex-col h-full min-h-0">
      <TabsList className="mx-3 mt-2 h-8 shrink-0 self-start">
        <TabsTrigger value="skills" className="h-6 text-xs">
          <Sparkles className="h-3.5 w-3.5" /> {t('chat:rightRail.skills', 'Skills')}
        </TabsTrigger>
        <TabsTrigger value="tools" className="h-6 text-xs">
          <Wrench className="h-3.5 w-3.5" /> {t('chat:rightRail.tools', 'Tools')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="skills" className="flex-1 min-h-0 mt-2">
        <SkillConfigView sessionId={sessionId} loadKey={loadKey} />
      </TabsContent>
      <TabsContent value="tools" className="flex-1 min-h-0 mt-2">
        <ToolConfigView sessionId={sessionId} />
      </TabsContent>
    </Tabs>
  );
}

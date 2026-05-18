/**
 * Build zone: the artefacts agents produce during the session.
 *
 * Phase 1 wires the three tabs that exist today (docs, api ref, tests).
 * Phase 3 adds the embedded Preview sidebar; Phase 7 adds the Git tab.
 * The "Build" zone name reflects that these are all outputs of the
 * builder-mode sandbox.
 */
import { useTranslation } from 'react-i18next';
import { BookOpen, BookText, FlaskConical, GitBranch } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../components/ui/tabs.js';
import DocsTab from '../../DocsTab.js';
import { CompanyApiReferenceTab } from '../../CompanyApiReferenceTab.js';
import { TestsTab } from '../../tests/TestsTab.js';
import { GitTab } from './GitTab.js';
import type { BuildTab } from '../types.js';

interface BuildZoneProps {
  sessionId: number;
  tab: BuildTab;
  onTabChange: (tab: BuildTab) => void;
}

export function BuildZone({ sessionId, tab, onTabChange }: BuildZoneProps) {
  const { t } = useTranslation('agents');

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as BuildTab)}
      className="flex-1 flex flex-col overflow-hidden"
    >
      <TabsList className="mx-3 mt-2 w-fit">
        <TabsTrigger value="docs" className="text-xs gap-1">
          <BookText className="h-3 w-3" /> {t('company.docs')}
        </TabsTrigger>
        <TabsTrigger value="api" className="text-xs gap-1">
          <BookOpen className="h-3 w-3" /> {t('company.apiReference')}
        </TabsTrigger>
        <TabsTrigger value="tests" className="text-xs gap-1">
          <FlaskConical className="h-3 w-3" /> Testes
        </TabsTrigger>
        <TabsTrigger value="git" className="text-xs gap-1">
          <GitBranch className="h-3 w-3" /> Git
        </TabsTrigger>
      </TabsList>

      <TabsContent value="docs" className="flex-1 overflow-hidden mt-0">
        <DocsTab companySessionId={sessionId} />
      </TabsContent>

      <TabsContent value="api" className="flex-1 overflow-hidden mt-0">
        <CompanyApiReferenceTab sessionId={sessionId} />
      </TabsContent>

      <TabsContent value="tests" className="flex-1 overflow-hidden mt-0">
        <TestsTab sessionId={sessionId} />
      </TabsContent>

      <TabsContent value="git" className="flex-1 overflow-hidden mt-0">
        <GitTab sessionId={sessionId} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * Build zone: artefacts agents produce during the session.
 *
 * Tabs (left rail): Docs, Tests, Files, Git and API Reference.
 * Files / Git / API moved from the right-side drawer to here so they
 * fill the full content column when active — preview stays as the
 * lone right-side artefact panel.
 *
 * Files/Git/API rely on the session's linked projects, fetched once
 * via `useSessionProjects` so tab switches don't re-hit the API. The
 * Terminal and Runners live in the shared bottom dock so they can coexist
 * with whichever build surface is open in the center.
 */
import DocsTab from '../../DocsTab.js';
import { TestsTab } from '../../tests/TestsTab.js';
import { FilesTab as BuilderFilesTab } from '../../../builder/preview/files/FilesTab.js';
import { GitTab as BuilderGitTab } from '../../../builder/preview/git/GitTab.js';
import { CompanyApiTab } from '../../CompanyApiTab.js';
import { useSessionProjects } from '../../../builder/preview/useSessionProjects.js';
import type { BuildTab } from '../types.js';
import { useSessionServices } from '../../tests/shared/useSessionServices.js';

interface BuildZoneProps {
  sessionId: string;
  tab: BuildTab;
}

export function BuildZone({ sessionId, tab }: BuildZoneProps) {
  const { projects, loading, error } = useSessionProjects(sessionId);
  const { services } = useSessionServices(sessionId);
  if (tab === 'docs') return <DocsTab companySessionId={sessionId} services={services} />;
  if (tab === 'tests') return <TestsTab sessionId={sessionId} />;

  // Files + Git need the project list. Render lightweight states while
  // the fetch settles so the tab doesn't flash empty.
  if (loading && projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Loading projects…</div>;
  }
  if (error) {
    return <div className="p-4 text-xs text-destructive">{error}</div>;
  }
  if (tab === 'api') {
    return <CompanyApiTab sessionId={sessionId} projects={projects} />;
  }
  if (tab === 'files') {
    return <BuilderFilesTab sessionId={sessionId} projects={projects} />;
  }
  return <BuilderGitTab sessionId={sessionId} projects={projects} />;
}

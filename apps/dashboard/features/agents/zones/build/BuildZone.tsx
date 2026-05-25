/**
 * Build zone: artefacts agents produce during the session.
 *
 * Tabs (left rail): Docs, Tests, Files, Git, API Reference, Terminal.
 * Files / Git / API moved from the right-side drawer to here so they
 * fill the full content column when active — preview stays as the
 * lone right-side artefact panel.
 *
 * Files/Git/API rely on the session's linked projects, fetched once
 * via `useSessionProjects` so tab switches don't re-hit the API. The
 * terminal tab is standalone — connects directly to `/ws/terminal/:id`.
 */
import DocsTab from '../../DocsTab.js';
import { TestsTab } from '../../tests/TestsTab.js';
import { FilesTab as BuilderFilesTab } from '../../../builder/preview/files/FilesTab.js';
import { GitTab as BuilderGitTab } from '../../../builder/preview/git/GitTab.js';
import { CompanyApiReferenceTab } from '../../CompanyApiReferenceTab.js';
import { CompanyTerminalPanel } from '../../terminal/CompanyTerminalPanel.js';
import { useSessionProjects } from '../../../builder/preview/useSessionProjects.js';
import { useSandboxStatus } from '../../../builder/useSandboxStatus.js';
import type { BuildTab } from '../types.js';

interface BuildZoneProps {
  sessionId: number;
  tab: BuildTab;
}

export function BuildZone({ sessionId, tab }: BuildZoneProps) {
  const { projects, loading, error } = useSessionProjects(sessionId);
  // Sandbox status is the source of truth for whether the "Sandbox"
  // spawn option appears in the terminal target menu. Tab content only
  // pays for the fetch when we render the terminal — cheap enough to
  // run unconditionally since useSandboxStatus is the same hook the
  // preview panel uses (cached per sessionId).
  const sandbox = useSandboxStatus(sessionId);
  const hasSandbox = !!sandbox.data?.containerId;

  if (tab === 'docs') return <DocsTab companySessionId={sessionId} />;
  if (tab === 'tests') return <TestsTab sessionId={sessionId} />;
  if (tab === 'api') return <CompanyApiReferenceTab sessionId={sessionId} />;
  if (tab === 'terminal') {
    return (
      <CompanyTerminalPanel
        companySessionId={sessionId}
        projects={projects}
        hasSandbox={hasSandbox}
      />
    );
  }

  // Files + Git need the project list. Render lightweight states while
  // the fetch settles so the tab doesn't flash empty.
  if (loading && projects.length === 0) {
    return <div className="p-4 text-xs text-muted-foreground">Loading projects…</div>;
  }
  if (error) {
    return <div className="p-4 text-xs text-destructive">{error}</div>;
  }
  if (tab === 'files') {
    return <BuilderFilesTab sessionId={sessionId} projects={projects} />;
  }
  return <BuilderGitTab sessionId={sessionId} projects={projects} />;
}

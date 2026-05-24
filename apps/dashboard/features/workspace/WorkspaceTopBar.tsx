/**
 * Workspace top bar — shows the active project + a switcher entry point.
 * Slim by design (h-9) so the editor + chat get maximum vertical space.
 * Right-side area reserved for future global actions (run, share, etc).
 */

import { FolderGit2, Layers, PanelBottomOpen, PanelBottomClose } from 'lucide-react';
import { Button } from '../../components/ui/button.js';

interface WorkspaceTopBarProps {
  projectName: string;
  bottomPanelOpen: boolean;
  onToggleBottomPanel: () => void;
  onBackToProject: () => void;
}

export function WorkspaceTopBar({
  projectName,
  bottomPanelOpen,
  onToggleBottomPanel,
  onBackToProject,
}: WorkspaceTopBarProps) {
  return (
    <header className="h-9 shrink-0 border-b bg-card/60 flex items-center px-3 gap-2">
      <button
        type="button"
        onClick={onBackToProject}
        className="flex items-center gap-1.5 text-xs hover:text-foreground text-muted-foreground transition-colors"
        aria-label="Back to project analytics"
      >
        <FolderGit2 className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium truncate" title={projectName}>
          {projectName}
        </span>
      </button>
      <span className="text-xs text-muted-foreground">·</span>
      <span className="text-xs flex items-center gap-1 text-muted-foreground">
        <Layers className="h-3 w-3" /> Workspace
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onToggleBottomPanel}
          aria-label={bottomPanelOpen ? 'Close bottom panel' : 'Open bottom panel'}
        >
          {bottomPanelOpen ? <PanelBottomClose className="h-3.5 w-3.5" /> : <PanelBottomOpen className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </header>
  );
}

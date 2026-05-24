/**
 * Workspace top bar — the IDE's own chrome (the global AppShell hides
 * itself in Workspace mode). Slim by design (h-9) so the editor + chat
 * get maximum vertical space, but never so minimal that the user can't
 * leave the workspace: Home + breadcrumb + analytics live on the left.
 */

import {
  ChevronRight,
  FolderGit2,
  Home,
  Layers,
  LineChart,
  PanelBottomClose,
  PanelBottomOpen,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js';

interface WorkspaceTopBarProps {
  projectId: number;
  projectName: string;
  bottomPanelOpen: boolean;
  onToggleBottomPanel: () => void;
  onBackToProject: () => void;
}

export function WorkspaceTopBar({
  projectId,
  projectName,
  bottomPanelOpen,
  onToggleBottomPanel,
  onBackToProject,
}: WorkspaceTopBarProps) {
  const navigate = useNavigate();

  return (
    <header className="h-9 shrink-0 border-b bg-gradient-to-b from-card/80 to-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/30 flex items-center px-2 gap-0.5 text-[12px]">
      {/* Home — always-visible escape hatch out of Workspace mode. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => navigate('/')}
            aria-label="Back to project list"
          >
            <Home className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">All projects</TooltipContent>
      </Tooltip>

      <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />

      {/* Project chip — clicking goes to analytics (the legacy ProjectDetail). */}
      <button
        type="button"
        onClick={onBackToProject}
        className="h-7 inline-flex items-center gap-1.5 px-2 rounded text-[12px] text-foreground hover:bg-muted transition-colors min-w-0"
        title={projectName}
      >
        <FolderGit2 className="h-3.5 w-3.5 text-primary shrink-0" />
        <span className="font-medium truncate">{projectName}</span>
      </button>

      <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />

      <span className="h-7 inline-flex items-center gap-1.5 px-2 text-[12px] text-muted-foreground font-medium">
        <Layers className="h-3 w-3" />
        Workspace
      </span>

      {/* Right cluster: analytics shortcut + panel toggle */}
      <div className="ml-auto flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => navigate(`/projects/${projectId}/analytics`)}
              aria-label="Open project analytics"
            >
              <LineChart className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Analytics view</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleBottomPanel}
              aria-label={bottomPanelOpen ? 'Close bottom panel' : 'Open bottom panel'}
            >
              {bottomPanelOpen ? (
                <PanelBottomClose className="h-3.5 w-3.5" />
              ) : (
                <PanelBottomOpen className="h-3.5 w-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Bottom panel</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

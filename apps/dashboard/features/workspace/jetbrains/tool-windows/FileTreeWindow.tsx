/**
 * Files tool window — wraps the existing FileTreeRail inside a tool
 * window frame (title bar + actions). The rail itself still owns the
 * recursive tree + click-to-open logic.
 *
 * Right-click actions (new file / rename / delete / copy path) land in
 * a follow-up commit; this commit just slots the existing tree into
 * the new JetBrains layout.
 */

import { FilePlus2, FolderPlus, RefreshCw } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip.js';
import { FileTreeView } from '../../file-tree/FileTreeView.js';
import { ToolWindowFrame } from '../ToolWindowFrame.js';

interface FileTreeWindowProps {
  projectId: number;
  activePath: string | null;
  onOpen: (path: string) => void;
  onClose?: () => void;
}

export function FileTreeWindow({ projectId, activePath, onOpen, onClose }: FileTreeWindowProps) {
  return (
    <ToolWindowFrame
      title="Project"
      onClose={onClose}
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                aria-label="New file"
                disabled
              >
                <FilePlus2 className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New file (coming soon)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                aria-label="New folder"
                disabled
              >
                <FolderPlus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">New folder (coming soon)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                aria-label="Reload"
                // FileTreeRail owns its own reload button in-tree; this
                // action is here for parity but no-ops until we lift
                // reload to a parent-controlled state.
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reload</TooltipContent>
          </Tooltip>
        </>
      }
    >
      <FileTreeView projectId={projectId} activePath={activePath} onOpen={onOpen} />
    </ToolWindowFrame>
  );
}

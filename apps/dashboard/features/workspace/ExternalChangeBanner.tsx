/**
 * Banner mostrado sobre o editor quando o arquivo aberto mudou no disco e há
 * edições não salvas (conflito). Oferece recarregar (pega o disco) ou manter
 * as edições. Em abas limpas o reload é silencioso (ProjectView), então o
 * banner só aparece em conflito real.
 */
import { TriangleAlert } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { reloadFromDisk } from './editor/reload-from-disk.js';

export function ExternalChangeBanner({ projectId, path }: { projectId: number; path: string }) {
  const dismiss = useWorkspaceStore((s) => s.dismissExternalChange);
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-[11.5px] text-amber-300">
      <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 min-w-0">Changed on disk while you had unsaved edits.</span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100"
        onClick={() => dismiss(projectId, path)}
      >
        Keep mine
      </Button>
      <Button size="sm" className="h-6 px-2" onClick={() => void reloadFromDisk(projectId, path)}>
        Reload
      </Button>
    </div>
  );
}

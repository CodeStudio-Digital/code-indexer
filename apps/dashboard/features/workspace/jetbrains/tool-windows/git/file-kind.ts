/**
 * Map a git file state to a single-letter badge + tailwind color. Shared
 * by the Changes pane (working-tree status) and the commit preview panel
 * (files touched by a commit) so the visual language stays identical
 * across the Git surface.
 */
export function fileKind(state: string): { letter: string; color: string } {
  switch (state) {
    case 'modified': return { letter: 'M', color: 'text-amber-500' };
    case 'added':    return { letter: 'A', color: 'text-emerald-500' };
    case 'deleted':  return { letter: 'D', color: 'text-destructive' };
    case 'renamed':  return { letter: 'R', color: 'text-cyan-400' };
    case 'copied':   return { letter: 'C', color: 'text-cyan-400' };
    case 'untracked':return { letter: '?', color: 'text-muted-foreground' };
    case 'unmerged': return { letter: '!', color: 'text-destructive' };
    default:         return { letter: '·', color: 'text-muted-foreground' };
  }
}

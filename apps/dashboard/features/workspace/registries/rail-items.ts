/**
 * Map plugin-contributed tool windows to activity-rail items for a given
 * side. Plugin windows share one generic icon (Puzzle); the merge with the
 * built-in rail arrays happens in Workspace.
 */
import { Puzzle } from 'lucide-react';
import type { RailItem } from '../jetbrains/ActivityRail.js';
import type { ContribToolWindow } from '../../../state/contribution-registry.js';

export function contributedRailItems(
  windows: ContribToolWindow[],
  side: 'left' | 'right',
): RailItem<string>[] {
  return windows
    .filter((w) => w.side === side)
    .map((w) => ({ id: w.id, label: w.title, icon: Puzzle }));
}

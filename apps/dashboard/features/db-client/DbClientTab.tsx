import { useEffect } from 'react';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';

/**
 * Compatibility target for old `?tab=databases` links.
 *
 * Database is no longer a dedicated primary surface. Its navigator lives in
 * the left workbench dock and every opened object is a normal editor tab.
 */
export function DbClientTab(): null {
  useEffect(() => {
    const layout = useWorkspaceLayout.getState();
    layout.setPrimarySurface('editor');
    layout.setActiveLeft('databases');
  }, []);
  return null;
}

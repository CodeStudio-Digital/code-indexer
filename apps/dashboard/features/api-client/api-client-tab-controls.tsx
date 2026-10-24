/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { useLayoutEffect, useState } from 'react';

/** Keeps portal children mounted even while their workbench dock is collapsed. */
export function useDockPortalRoot(host: HTMLElement | null, name: string) {
  const [root] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.className = 'h-full min-h-0 overflow-hidden';
    element.dataset.apiWorkbenchPortal = name;
    return element;
  });

  useLayoutEffect(() => {
    if (!root) return;
    if (host) host.appendChild(root);
    else root.remove();
    return () => root.remove();
  }, [host, root]);

  return root;
}

/** Segmented Client / Docs switch shown in the API tab when docs access is on. */
export function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded transition-colors ${active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}

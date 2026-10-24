/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { lazy } from 'react';

// Docs Studio lives INSIDE this tab (Client / Docs toggle), not as its own rail
// tab — lazy so its heavy deps (Scalar, Monaco) don't weigh on the client view.
export const DocsStudioView = lazy(() => import('./docs-studio/DocsStudioView.js').then((m) => ({ default: m.DocsStudioView })));

export const RESP_TABS = [
  { id: 'response' as const, labelKey: 'response' },
  { id: 'history' as const, labelKey: 'history' },
];

export const NAV_TABS = [
  { id: 'collections' as const, labelKey: 'collections' },
  { id: 'environments' as const, labelKey: 'environments' },
];

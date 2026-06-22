/**
 * Per-project Docs Studio UI state (which side regions are minimized), persisted
 * to localStorage. Mirrors api-client-ui-state's read-modify-write. Pane SIZES
 * are handled by react-resizable-panels' autoSaveId; this only tracks collapse.
 *
 * The "authoring" region is tree + editor TOGETHER (the editor's content depends
 * on the tree selection, so they hide as one unit); "preview" is the live shell.
 */
export interface DocsStudioUi {
  authoringCollapsed: boolean;
  rightCollapsed: boolean;
}

const DEFAULTS: DocsStudioUi = { authoringCollapsed: false, rightCollapsed: false };
const keyFor = (projectId: number) => `mcp-ide:docs-studio-ui:${projectId}`;

export function loadDocsStudioUi(projectId: number): DocsStudioUi {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(keyFor(projectId));
    if (!raw) return DEFAULTS;
    const o = JSON.parse(raw) as Partial<DocsStudioUi>;
    return { authoringCollapsed: !!o.authoringCollapsed, rightCollapsed: !!o.rightCollapsed };
  } catch {
    return DEFAULTS;
  }
}

export function saveDocsStudioUi(projectId: number, slice: Partial<DocsStudioUi>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify({ ...loadDocsStudioUi(projectId), ...slice }));
  } catch {
    /* quota / disabled — drop */
  }
}

// Legacy file — kept only as a re-export so existing imports keep working.
// The actual implementation lives in `preview/PreviewContainer.tsx`, which
// now wraps the iframe plus new Files/Git tabs for an IDE-lite experience
// inside the session.
export { PreviewContainer as PreviewPanel } from './preview/PreviewContainer.js';
export type { PreviewContainerProps as PreviewPanelProps } from './preview/PreviewContainer.js';

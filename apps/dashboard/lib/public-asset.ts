/**
 * URL for a file served from the dashboard's `public/` directory.
 *
 * Always use this instead of writing `src="/brand/logo-mark.svg"` by hand.
 *
 * Two things break hand-written paths in the packaged desktop app, which loads
 * the renderer from disk (`win.loadFile` → `file://`) instead of a dev server:
 *
 *  1. An absolute `/…` path resolves against the document ORIGIN, which under
 *     `file://` is the drive root — `file:///D:/brand/logo-mark.svg`, a 404.
 *     Vite rewrites such paths inside `index.html` (that is what `base` does)
 *     but never sees strings living in component code.
 *
 *  2. A *relative* path is no better once the app has mounted: `BrowserRouter`
 *     pushes its routes onto `history`, and under `file://` that collapses
 *     `location` to `file:///D:/`. Anything resolved against the live document
 *     base AFTER mount therefore points at the drive root too. Measured in a
 *     packaged build: `location.href` is the real `index.html` right after load
 *     and `file:///D:/` a moment later.
 *
 * So the base is snapshotted HERE, at module-evaluation time — which happens
 * while `location` is still `index.html`, before React renders and the router
 * touches history — and every asset URL is resolved to an absolute href
 * against that snapshot. The result is immune to whatever the router does
 * later. In dev the same code yields `http://localhost:<port>/brand/…`.
 */
const BASE_HREF = new URL(import.meta.env.BASE_URL, document.baseURI).href;

export function publicAsset(relativePath: string): string {
  return new URL(relativePath.replace(/^\/+/, ''), BASE_HREF).href;
}

/** The CodeStudio mark, used by the app menu and the About dialog. */
export const LOGO_MARK_URL = publicAsset('brand/logo-mark.svg');

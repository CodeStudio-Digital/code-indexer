import { i18nReady } from './i18n/index.js';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import App from './App.js';
import './index.css';
import { installFetchBase, isElectronRenderer } from './lib/install-fetch-base.js';
// Side-effect import: snapshots the document base used to build `public/` asset
// URLs. It has to happen while `location` is still index.html — once the router
// mounts, `file://` history collapses it to the drive root. Anchored here (not
// left to whichever component imports it first) so making a component lazy
// cannot silently move the snapshot past that point. See lib/public-asset.ts.
import './lib/public-asset.js';
import { startUserTimingBufferGuard } from './lib/perf/user-timing-guard.js';
import { ensureRendererVitals } from './features/admin/perf/renderer-vitals.js';

// Desktop content is selectable; native controls opt out explicitly. Keep
// the marker on <html> so popouts (which mount outside AppShell) share the same
// policy and the browser dashboard remains unaffected.
document.documentElement.dataset.appRuntime = isElectronRenderer() ? 'electron' : 'browser';

// Rewrites `/api/*` and `/ws/*` to the absolute backend URL when running
// inside Electron. No-op in browser dev. Must run before any component
// fires a fetch.
installFetchBase();

// Observe renderer freezes for the whole app lifetime, not only while the
// Admin > Performance panel is mounted. The collector first journals events to
// localStorage, then retries bounded batches against the backend.
ensureRendererVitals();

// Route-startup telemetry is OFF by default now — it ref-counts on only while
// an admin perf panel is mounted (see acquireRouteMetricsCollection). We do keep
// a low-frequency guard that bounds the User Timing buffer in long sessions.
startUserTimingBufferGuard();

// React.StrictMode intentionally omitted: it double-invokes effects in
// dev to catch ordering bugs, but Monaco's editor instance keeps a
// services container that can't survive the second teardown. The
// production bundle is unaffected either way (StrictMode is a dev-only
// helper).
async function renderApp(): Promise<void> {
  try {
    await i18nReady;
  } catch (error) {
    // A missing optional namespace should not strand the desktop shell on a
    // blank page; react-i18next can still surface keys through its fallback.
    console.error('[i18n] bootstrap failed', error);
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
}

void renderApp();

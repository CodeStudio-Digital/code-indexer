import './i18n/index.js';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';
import { installFetchBase } from './lib/install-fetch-base.js';
import { setupMonaco } from './lib/monaco-setup.js';
import {
  ensureRouteStartupMetrics,
  startInitialProjectRouteFromLocation,
} from './lib/perf/route-startup-metrics.js';

// Rewrites `/api/*` and `/ws/*` to the absolute backend URL when running
// inside Electron. No-op in browser dev. Must run before any component
// fires a fetch.
installFetchBase();

// Bundle + register Monaco workers before anything mounts the editor.
// Without this, @monaco-editor/react would CDN-load Monaco and create a
// services container that gets disposed by React's double-mount in dev,
// throwing "InstantiationService has been disposed" on the second mount.
setupMonaco();
ensureRouteStartupMetrics();
startInitialProjectRouteFromLocation();

// React.StrictMode intentionally omitted: it double-invokes effects in
// dev to catch ordering bugs, but Monaco's editor instance keeps a
// services container that can't survive the second teardown. The
// production bundle is unaffected either way (StrictMode is a dev-only
// helper).
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

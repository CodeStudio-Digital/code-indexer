import { useEffect, useState } from 'react';
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { DialogProvider } from './components/ui/dialog-provider.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import {
  PromptDialogHost,
  ConfirmDialogHost,
  ToastHost,
} from './components/ui/prompt-dialog.js';
import Admin from './features/admin/index.js';
import { ProjectDetail, ProjectList, ProjectView } from './features/project/index.js';
import { AgentsTab } from './features/agents/AgentsTab.js';
import { DesignSystemsTab } from './features/design-systems/DesignSystemsTab.js';
import { TelemetryDashboard } from './features/telemetry/TelemetryDashboard.js';
import { DocsPage } from './features/docs/DocsPage.js';
import { useFeatures } from './hooks/useFeatures.js';
import { useApi } from './hooks/useApi.js';
import { AppShell } from './AppShell.js';
import { buildAgentsDefaultUrl } from './features/agents/routing.js';
import { OnboardingWizard, isOnboarded, resetOnboarding } from './features/onboarding/OnboardingWizard.js';
import { PreflightWizard, isPreflightDone, isElectronRenderer, resetPreflight } from './features/preflight/index.js';
import { installWebviewBridge } from './features/workspace/webview-bridge.js';

// ─── Route components ────────────────────────────────────────

/**
 * Element for the root `/` route. Owns the AppShell chrome AND the
 * onboarding wizard overlay.
 *
 * Why this exists instead of just using `<AppShell />` as the route:
 * the wizard's ProjectStep calls `useNavigate()` to jump to the new
 * project's Workspace after creation. `useNavigate` is a hook that
 * MUST be evaluated inside the React Router tree (i.e. somewhere
 * under `<RouterProvider>`). When the wizard sat as a sibling of
 * `<RouterProvider>` in App(), the hook threw an `invariant` on the
 * first render of ProjectStep and tore the whole tree down → blank
 * screen colored by the theme background.
 *
 * Putting the wizard inside an AppRoot that itself is the element of
 * the `/` route fixes that — the wizard is now inside the Router
 * tree and `useNavigate` resolves correctly.
 */
function AppRoot() {
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboarded());
  // Preflight gates ahead of onboarding, desktop-only (no HTTP fallback for
  // system.* in browser dev). Live host checks run inside the wizard.
  const [showPreflight, setShowPreflight] = useState(() => isElectronRenderer() && !isPreflightDone());
  const navigate = useNavigate();

  // Dev helpers — surfaced via DevTools console so QA can re-run the
  // wizard, inspect Electron bridge state, etc. without rebuilding.
  //   window.mcp.resetOnboarding()  → clears the flag + shows the wizard
  //   window.mcp.transport          → 'electron' | 'browser' (sanity check)
  //   window.mcp.hasBridge          → was the preload able to expose electronAPI?
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isElectron =
      typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent);
    (window as unknown as { mcp?: object }).mcp = {
      transport: isElectron ? 'electron' : 'browser',
      hasBridge: !!window.electronAPI,
      resetOnboarding: () => {
        resetOnboarding();
        setShowOnboarding(true);
      },
      resetPreflight: () => {
        resetPreflight();
        setShowPreflight(true);
      },
    };
  }, []);

  // Deep-link from `window.electronAPI.openInNewWindow(route)`. In dev
  // the main process appends the route to the Vite URL and BrowserRouter
  // picks it up via pathname automatically. In production we `loadFile`
  // the bundled index.html with `{ hash: route }` — BrowserRouter can't
  // read that, so we navigate manually on mount. The hash is consumed
  // (cleared) so refresh inside the window doesn't double-fire.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash || hash === '#' || hash === '#/') return;
    const route = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!route.startsWith('/')) return;
    // Clear the hash so a manual refresh in the new window doesn't
    // re-run navigation if the user has since navigated elsewhere.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    navigate(route, { replace: true });
  }, [navigate]);

  // Plugin webview bridge — host side of the postMessage channel for
  // sandboxed plugin iframes (namespace-bound invokeTool / storage /
  // permissions). Mounted once here at the app root; the legacy Workspace
  // mount is dead. Returns a disposer.
  useEffect(() => installWebviewBridge(), []);

  return (
    <>
      <AppShell />
      {showPreflight ? (
        <PreflightWizard onDone={() => setShowPreflight(false)} />
      ) : (
        showOnboarding && <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
      )}
    </>
  );
}

function HomeRoute() {
  const navigate = useNavigate();
  return <ProjectList onSelectProject={(id) => navigate(`/projects/${id}`)} />;
}

function ProjectRoute() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const projectId = Number(id);
  const project = useApi<{ id: number; name: string }>(
    Number.isFinite(projectId) ? `/projects/${projectId}` : '',
  );

  if (!Number.isFinite(projectId)) return <Navigate to="/" replace />;
  if (!project.data) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">Loading project…</div>;
  }

  const sessionIdRaw = searchParams.get('session');
  const initialSessionId = sessionIdRaw ? Number(sessionIdRaw) : undefined;

  return (
    <ProjectDetail
      projectId={projectId}
      projectName={project.data.name}
      initialSessionId={Number.isFinite(initialSessionId) ? initialSessionId : undefined}
    />
  );
}

/**
 * `/projects/:id` — the unified project IDE surface (ProjectView).
 *
 * Replaces the standalone JetBrains-style Workspace AND the old
 * analytics-only ProjectDetail tab list. Renders inside the AppShell
 * chrome (the topbar nav stays visible) so users can jump between
 * Projetos / Agentes / Admin / etc. without leaving the project they
 * just opened.
 *
 * The legacy `/projects/:id/analytics` route still works for the
 * chart-heavy slice — ProjectView exposes a button on its topbar to
 * open it. We may consolidate further once analytics graduates into
 * its own tab in the rail.
 */
function ProjectViewRoute() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const projectId = Number(id);
  const project = useApi<{ id: number; name: string }>(
    Number.isFinite(projectId) ? `/projects/${projectId}` : '',
  );

  if (!Number.isFinite(projectId)) return <Navigate to="/" replace />;
  if (!project.data) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">Loading project…</div>;
  }

  const sessionIdRaw = searchParams.get('session');
  const initialSessionId = sessionIdRaw ? Number(sessionIdRaw) : undefined;

  return (
    <ProjectView
      projectId={projectId}
      projectName={project.data.name}
      initialSessionId={Number.isFinite(initialSessionId) ? initialSessionId : undefined}
    />
  );
}

function CompanyRedirectRoute() {
  const { rootId } = useParams<{ rootId: string }>();
  const id = Number(rootId);
  if (!Number.isFinite(id)) return <Navigate to="/agents" replace />;
  return <Navigate to={buildAgentsDefaultUrl(id)} replace />;
}

function DesignSystemsRoute() {
  const features = useFeatures();
  if (!features.designSystemEnabled) return <Navigate to="/" replace />;
  return <DesignSystemsTab />;
}

// ─── Router setup ────────────────────────────────────────────

const router = createBrowserRouter([
  {
    path: '/',
    // AppRoot wraps AppShell + the onboarding wizard overlay so the
    // wizard renders inside the Router context (useNavigate works).
    // AppShell itself renders <Outlet />, so the children below still
    // mount exactly where they did before.
    element: <AppRoot />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: 'projects/:id', element: <ProjectViewRoute /> },
      { path: 'projects/:id/analytics', element: <ProjectRoute /> },
      { path: 'agents', element: <AgentsTab /> },
      { path: 'company/sessions/:rootId', element: <CompanyRedirectRoute /> },
      { path: 'company/sessions/:rootId/:frontId/:zone/:tab', element: <AgentsTab /> },
      { path: 'admin', element: <Admin /> },
      { path: 'design-systems', element: <DesignSystemsRoute /> },
      { path: 'telemetry', element: <TelemetryDashboard /> },
      { path: 'docs', element: <DocsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <DialogProvider>
        <RouterProvider router={router} />
        {/* Global hosts — replace Electron-blocked window.prompt/confirm/alert
            with promise-based dialogs + a toast surface. Mounted once near
            the React root so any component can call prompt()/confirm()/toast.*
            These DO sit outside the Router on purpose: they don't use any
            Router hooks (they have their own Zustand stores). The
            onboarding wizard moved INSIDE the Router via AppRoot above. */}
        <PromptDialogHost />
        <ConfirmDialogHost />
        <ToastHost />
      </DialogProvider>
    </TooltipProvider>
  );
}

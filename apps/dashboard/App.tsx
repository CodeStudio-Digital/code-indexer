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
import Admin from './features/admin/index.js';
import { ProjectDetail, ProjectList } from './features/project/index.js';
import { AgentsTab } from './features/agents/AgentsTab.js';
import { DesignSystemsTab } from './features/design-systems/DesignSystemsTab.js';
import { TelemetryDashboard } from './features/telemetry/TelemetryDashboard.js';
import { DocsPage } from './features/docs/DocsPage.js';
import { useFeatures } from './hooks/useFeatures.js';
import { useApi } from './hooks/useApi.js';
import { AppShell } from './AppShell.js';
import { buildAgentsDefaultUrl } from './features/agents/routing.js';

// ─── Route components ────────────────────────────────────────

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
    element: <AppShell />,
    children: [
      { index: true, element: <HomeRoute /> },
      { path: 'projects/:id', element: <ProjectRoute /> },
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
      </DialogProvider>
    </TooltipProvider>
  );
}

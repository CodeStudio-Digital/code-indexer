/**
 * Sidebar + topbar layout that wraps every routed page. Extracted from
 * `App.tsx` so the router can mount it once and let route children
 * render into the `<Outlet />`.
 *
 * Theme + sidebar-collapsed state are local to the shell because they
 * persist independent of the route. Nav buttons highlight based on
 * `useLocation()`.
 */
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BookOpen,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  Home,
  Menu,
  Moon,
  Palette,
  Settings,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { Button } from './components/ui/button.js';
import { TooltipTrigger, Tooltip, TooltipContent } from './components/ui/tooltip.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { RecentSessionsList } from './features/recent/RecentSessionsList.js';
import { useFeatures } from './hooks/useFeatures.js';
import { useApi } from './hooks/useApi.js';
import { cn } from './lib/utils.js';

interface NavButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}

function NavButton({ icon, label, active, collapsed, onClick }: NavButtonProps) {
  const btn = (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
        collapsed && 'justify-center px-2',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return btn;
}

/**
 * Parsed view of the current URL — drives sidebar highlighting and the
 * breadcrumb in the topbar without ad-hoc string matching at the call site.
 */
interface ActiveView {
  page: 'home' | 'project' | 'agents' | 'admin' | 'design-systems' | 'telemetry' | 'docs' | 'other';
  projectId: number | null;
  sessionId: number | null;
}

function parsePathname(pathname: string, search: string): ActiveView {
  if (pathname === '/' || pathname === '') {
    return { page: 'home', projectId: null, sessionId: null };
  }
  if (pathname.startsWith('/projects/')) {
    const id = Number(pathname.split('/')[2]);
    const params = new URLSearchParams(search);
    const sessionIdRaw = params.get('session');
    return {
      page: 'project',
      projectId: Number.isFinite(id) ? id : null,
      sessionId: sessionIdRaw ? Number(sessionIdRaw) : null,
    };
  }
  if (pathname === '/agents' || pathname.startsWith('/company/sessions/')) {
    return { page: 'agents', projectId: null, sessionId: null };
  }
  if (pathname.startsWith('/admin')) return { page: 'admin', projectId: null, sessionId: null };
  if (pathname.startsWith('/design-systems')) return { page: 'design-systems', projectId: null, sessionId: null };
  if (pathname.startsWith('/telemetry')) return { page: 'telemetry', projectId: null, sessionId: null };
  if (pathname.startsWith('/docs')) return { page: 'docs', projectId: null, sessionId: null };
  return { page: 'other', projectId: null, sessionId: null };
}

export function AppShell() {
  const { t } = useTranslation();
  const features = useFeatures();
  const location = useLocation();
  const navigate = useNavigate();
  const view = useMemo(
    () => parsePathname(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem('sidebarCollapsed') === 'true',
  );
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  function toggleCollapsed() {
    setSidebarCollapsed((v) => {
      localStorage.setItem('sidebarCollapsed', String(!v));
      return !v;
    });
  }

  function go(path: string) {
    navigate(path);
    setMobileSidebarOpen(false);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div
        className={cn(
          'grid grid-cols-1 min-h-screen',
          sidebarCollapsed ? 'md:grid-cols-[60px_1fr]' : 'md:grid-cols-[260px_1fr]',
        )}
      >
        <aside
          className={cn(
            'flex flex-col border-r bg-card',
            'fixed inset-y-0 left-0 z-40 transition-all duration-200',
            'md:relative md:translate-x-0 md:z-auto',
            sidebarCollapsed ? 'md:w-[60px]' : 'md:w-auto',
            mobileSidebarOpen ? 'translate-x-0 w-64' : '-translate-x-full w-64',
          )}
        >
          <button
            className="md:hidden absolute top-3 right-3 p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
          <div
            className={cn(
              'h-16 flex items-center border-b',
              sidebarCollapsed ? 'justify-center px-2' : 'gap-2.5 px-5',
            )}
          >
            <div className="h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-sm shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            {!sidebarCollapsed && (
              <div className="flex flex-col leading-tight">
                <span className="font-semibold text-sm">MCP Indexer</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  v{__APP_VERSION__}
                </span>
              </div>
            )}
          </div>
          <nav
            className={cn('flex-1 p-3 space-y-1 overflow-hidden', sidebarCollapsed && 'px-1.5')}
          >
            <NavButton
              icon={<Home className="h-4 w-4 shrink-0" />}
              label={t('nav.projects')}
              active={view.page === 'home'}
              collapsed={sidebarCollapsed}
              onClick={() => go('/')}
            />
            <NavButton
              icon={<Users className="h-4 w-4 shrink-0" />}
              label={t('nav.agents')}
              active={view.page === 'agents'}
              collapsed={sidebarCollapsed}
              onClick={() => go('/agents')}
            />
            {features.designSystemEnabled && (
              <NavButton
                icon={<Palette className="h-4 w-4 shrink-0" />}
                label={t('nav.designSystems')}
                active={view.page === 'design-systems'}
                collapsed={sidebarCollapsed}
                onClick={() => go('/design-systems')}
              />
            )}
            <NavButton
              icon={<Activity className="h-4 w-4 shrink-0" />}
              label={t('nav.telemetry')}
              active={view.page === 'telemetry'}
              collapsed={sidebarCollapsed}
              onClick={() => go('/telemetry')}
            />
            <NavButton
              icon={<BookOpen className="h-4 w-4 shrink-0" />}
              label={t('nav.docs')}
              active={view.page === 'docs'}
              collapsed={sidebarCollapsed}
              onClick={() => go('/docs')}
            />
            <NavButton
              icon={<Settings className="h-4 w-4 shrink-0" />}
              label={t('nav.admin')}
              active={view.page === 'admin'}
              collapsed={sidebarCollapsed}
              onClick={() => go('/admin')}
            />
            {!sidebarCollapsed && view.page === 'project' && view.projectId != null && (
              <ActiveProjectIndicator projectId={view.projectId} />
            )}
            {!sidebarCollapsed && (
              <RecentSessionsList
                activeSessionId={view.sessionId}
                onSelect={(id, _name, sessionId) =>
                  go(`/projects/${id}${sessionId ? `?session=${sessionId}` : ''}`)
                }
              />
            )}
          </nav>
          <div
            className={cn(
              'border-t flex',
              sidebarCollapsed ? 'p-1.5 flex-col items-center gap-1' : 'p-2 flex-row items-center gap-1',
            )}
          >
            <LanguageSwitcher />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDark((d) => !d)}
                  aria-label={t('theme.toggle')}
                  className="h-8 w-8"
                >
                  {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{t('theme.toggle')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    'hidden md:flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors h-8 w-8',
                    !sidebarCollapsed && 'ml-auto',
                  )}
                  onClick={toggleCollapsed}
                  aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  {sidebarCollapsed ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronLeft className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
              </TooltipContent>
            </Tooltip>
          </div>
        </aside>

        <div className="flex flex-col min-w-0">
          <main
            className={cn(
              'flex-1 w-full mx-auto min-h-0',
              view.page !== 'agents'
                && view.page !== 'design-systems'
                && view.page !== 'project'
                && 'px-3 py-4 sm:px-6 sm:py-6',
            )}
          >
            <Outlet />
          </main>
        </div>
      </div>

      {/* Mobile-only floating button to open the sidebar drawer, since the
          top header that used to host the burger is gone. */}
      <button
        type="button"
        onClick={() => setMobileSidebarOpen(true)}
        aria-label="Open navigation"
        className="md:hidden fixed top-2 left-2 z-40 p-2 rounded-md bg-card/90 border shadow-sm text-muted-foreground hover:text-foreground"
      >
        <Menu className="h-4 w-4" />
      </button>

      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
    </div>
  );
}

function ActiveProjectIndicator({ projectId }: { projectId: number }) {
  const { data } = useApi<{ id: number; name: string }>(`/projects/${projectId}`);
  return (
    <div className="px-3 py-2 rounded-lg bg-primary/10 text-primary flex items-center gap-2 text-sm font-medium">
      <FolderGit2 className="h-4 w-4 shrink-0" />
      <span className="truncate">{data?.name ?? `#${projectId}`}</span>
    </div>
  );
}

/**
 * Top horizontal navbar that wraps non-workspace routes. The Workspace
 * IDE (`/projects/:id`) opts out via `view.page === 'project'` and runs
 * full-bleed; everything else (home / agents / admin / telemetry / docs /
 * design-systems) gets the nav bar.
 *
 * Design intent: feels like a software's top menu — small (h-9), tight
 * font (text-xs / 11-12px), icons + labels. Replaces the old left
 * sidebar to free vertical space for content.
 */
import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BookOpen,
  Boxes,
  Clock,
  Home,
  Moon,
  Palette,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { Button } from './components/ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { useFeatures } from './hooks/useFeatures.js';
import { useApi } from './hooks/useApi.js';
import { cn } from './lib/utils.js';

interface ActiveView {
  page: 'home' | 'project' | 'project-analytics' | 'agents' | 'admin' | 'design-systems' | 'telemetry' | 'docs' | 'other';
  projectId: number | null;
  sessionId: number | null;
}

function parsePathname(pathname: string, search: string): ActiveView {
  if (pathname === '/' || pathname === '') {
    return { page: 'home', projectId: null, sessionId: null };
  }
  if (pathname.startsWith('/projects/')) {
    const parts = pathname.split('/');
    const id = Number(parts[2]);
    const subpath = parts[3];
    const params = new URLSearchParams(search);
    const sessionIdRaw = params.get('session');
    // Only the bare `/projects/:id` (Workspace) gets full-bleed. The
    // `/analytics` subpath keeps the AppShell chrome so the user can
    // navigate away — was the dead-end bug the user hit.
    const page: ActiveView['page'] = subpath === 'analytics' ? 'project-analytics' : 'project';
    return {
      page,
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

interface NavItem {
  id: ActiveView['page'];
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  show?: boolean;
}

interface NavButtonProps {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}

function NavButton({ item, active, onClick }: NavButtonProps) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-7 inline-flex items-center gap-1.5 px-2 rounded text-[11px] font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-3 w-3" />
      <span>{item.label}</span>
    </button>
  );
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

  // Workspace mode opts out of the AppShell chrome entirely — the IDE
  // owns 100dvh. Outlet renders directly.
  if (view.page === 'project') {
    return (
      <div className="h-[100dvh] w-full bg-background text-foreground overflow-hidden">
        <Outlet />
      </div>
    );
  }

  const nav: NavItem[] = [
    { id: 'home', label: t('nav.projects'), icon: Home, href: '/' },
    { id: 'agents', label: t('nav.agents'), icon: Users, href: '/agents' },
    {
      id: 'design-systems',
      label: t('nav.designSystems'),
      icon: Palette,
      href: '/design-systems',
      show: features.designSystemEnabled,
    },
    { id: 'telemetry', label: t('nav.telemetry'), icon: Activity, href: '/telemetry' },
    { id: 'docs', label: t('nav.docs'), icon: BookOpen, href: '/docs' },
    { id: 'admin', label: t('nav.admin'), icon: Settings, href: '/admin' },
  ].filter((n) => n.show !== false);

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground">
      <header className="h-9 shrink-0 border-b bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-2 gap-1">
        {/* Brand */}
        <button
          type="button"
          onClick={() => navigate('/')}
          className="h-7 inline-flex items-center gap-1.5 px-2 rounded text-[12px] font-semibold text-foreground hover:bg-muted"
          aria-label="MCP IDE — home"
        >
          <span className="h-5 w-5 rounded-md bg-primary text-primary-foreground grid place-items-center">
            <Boxes className="h-3 w-3" />
          </span>
          <span>MCP&nbsp;IDE</span>
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider font-normal">
            v{__APP_VERSION__}
          </span>
        </button>
        <span className="h-4 w-px bg-border mx-0.5" />
        {/* Nav */}
        <nav className="flex items-center gap-0.5" aria-label="Primary">
          {nav.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={view.page === item.id}
              onClick={() => navigate(item.href)}
            />
          ))}
        </nav>
        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-0.5">
          <RecentSessionsDropdown
            activeSessionId={view.sessionId}
            onSelect={(projectId, sessionId) =>
              navigate(`/projects/${projectId}${sessionId ? `?session=${sessionId}` : ''}`)
            }
          />
          <LanguageSwitcher />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDark((d) => !d)}
                aria-label={t('theme.toggle')}
                className="h-7 w-7"
              >
                {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('theme.toggle')}</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Compact "Recent sessions" dropdown in the topbar. Replaces the
 * always-visible sidebar list — saves vertical space and keeps the
 * topbar dense.
 */
function RecentSessionsDropdown({
  activeSessionId,
  onSelect,
}: {
  activeSessionId: number | null;
  onSelect: (projectId: number, sessionId: number) => void;
}) {
  // RecentCoderSession = CoderSession + project_name (see @mcp/code-agent
  // sessions/types). The store query joins projects on project_id.
  const { data } = useApi<
    Array<{ id: number; title: string; project_id: number; project_name: string }>
  >('/coder/sessions/recent?limit=10');

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Recent sessions">
              <Clock className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Recent sessions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Recent
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(!data || data.length === 0) && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No recent sessions yet.</div>
        )}
        {data?.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <DropdownMenuItem
              key={s.id}
              onClick={() => onSelect(s.project_id, s.id)}
              className={cn('flex flex-col items-start gap-0.5 text-xs', active && 'bg-accent')}
            >
              <span className="font-medium truncate w-full">{s.title}</span>
              <span className="text-[10px] text-muted-foreground truncate w-full">
                {s.project_name}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

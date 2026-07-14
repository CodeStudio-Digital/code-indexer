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
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BookOpen,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Home,
  ImagePlay,
  Moon,
  Orbit,
  Palette,
  Pin,
  PinOff,
  Search,
  Settings,
  Sparkles,
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
import { CloudStatusButton } from './features/account/CloudStatusButton.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { RunningTasksDropdown } from './components/RunningTasksDropdown.js';
import { AppMenu } from './components/AppMenu.js';
import { WindowControls } from './components/WindowControls.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';
import { buildCommandActions } from './components/command-actions.js';
import { PinnedTabsBar } from './components/pinned-tabs/PinnedTabsBar.js';
import { parseView, type ActiveView } from './lib/route-view.js';
import { usePinnedTabs } from './state/pinned-tabs.js';
import { useActiveSurface } from './state/active-surface.js';
import { describeCurrentPin } from './state/pinned-tabs-describe.js';
import { installKeymapDispatcher } from './keymap/dispatcher.js';
import { registerCommandHandlers } from './keymap/commands.js';
import { useWindowChrome } from './hooks/useWindowChrome.js';
import { initRunningTasks } from './state/running-tasks.js';
import { useFeatures } from './hooks/useFeatures.js';
import { useApi } from './hooks/useApi.js';
import { cn } from './lib/utils.js';
import { ProjectBranchControl, ProjectRunControl } from './features/project/ProjectIdeToolbar.js';

interface NavItem {
  id: ActiveView['page'] | string;
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
  // Active tab keeps its label (so the user never loses their place);
  // inactive tabs collapse to icon-only and slide the label open on
  // hover/keyboard-focus — a width+opacity transition that saves the bulk
  // of the nav's horizontal space. `aria-label` carries the name while the
  // text is visually collapsed.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group/nav h-7 inline-flex items-center rounded px-1.5 text-[11px] font-medium transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span
        className={cn(
          'overflow-hidden whitespace-nowrap transition-all duration-150 ease-out',
          active
            ? 'ml-1.5 max-w-[170px] opacity-100'
            : 'ml-0 max-w-0 opacity-0 group-hover/nav:ml-1.5 group-hover/nav:max-w-[170px] group-hover/nav:opacity-100 group-focus-visible/nav:ml-1.5 group-focus-visible/nav:max-w-[170px] group-focus-visible/nav:opacity-100',
        )}
      >
        {item.label}
      </span>
    </button>
  );
}

export function AppShell() {
  const { t, i18n } = useTranslation();
  const features = useFeatures();
  const location = useLocation();
  const navigate = useNavigate();
  const { platform, isFocused } = useWindowChrome();
  const view = useMemo(
    () => parseView(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Open the runner events stream once so the topbar indicator (and the
  // project Runners tab) reflect live task state across navigation.
  useEffect(() => {
    initRunningTasks();
  }, []);

  // Install the single global dispatcher at shell lifetime. Ctrl+K is a
  // catalogue action now, so it can be remapped and can also be the prefix
  // of a longer chord (the dispatcher resolves the exact-prefix timeout).
  useEffect(() => {
    const uninstall = installKeymapDispatcher();
    const unregister = registerCommandHandlers([{
      id: 'workbench.commandPalette',
      run: () => setPaletteOpen((open) => !open),
    }]);
    return () => { unregister(); uninstall(); };
  }, []);

  // Breadcrumb name + palette sources. Both endpoints are tiny; the
  // recent-sessions one is also read by RecentSessionsDropdown (cheap).
  const isProjectView = view.page === 'project';
  const isAppStudioWorkbench = /^\/apps\/\d+(?:\/|$)/.test(location.pathname);
  const isCompanyWorkbench = view.page === 'agents';
  const isSpriteWorkbench = view.page === 'sprites';
  const isWorkbenchView = isProjectView || isAppStudioWorkbench || isCompanyWorkbench || isSpriteWorkbench;
  const { data: activeProject } = useApi<{ name: string }>(
    isProjectView && view.projectId ? `/projects/${view.projectId}` : '',
  );
  const projectName = isProjectView ? (activeProject?.name ?? null) : null;
  const { data: projectsData } = useApi<Array<{ id: number; name: string; root_path?: string }>>('/projects');
  const { data: recentData } = useApi<
    Array<{ id: number; title: string; project_id: number; project_name: string }>
  >('/coder/sessions/recent?limit=10');

  // Pinned tabs: the header button pins/unpins the CURRENT view. `currentPin`
  // is null on pages with no pinnable target (button hidden). Rail capture
  // reads the live active tab from active-surface (not the URL — see that store).
  const activeProjectTab = useActiveSurface((s) => s.projectTab);
  const togglePin = usePinnedTabs((s) => s.togglePin);
  const currentPin = useMemo(
    () =>
      describeCurrentPin({
        view,
        pathname: location.pathname,
        search: location.search,
        activeProjectTab,
        names: {
          projectName,
          sessionTitle: recentData?.find((s) => s.id === view.sessionId)?.title ?? null,
        },
      }),
    [view, location.pathname, location.search, activeProjectTab, projectName, recentData],
  );
  const currentPinned = usePinnedTabs((s) =>
    currentPin ? s.pins.some((p) => p.id === currentPin.id) : false,
  );

  // NOTE: ProjectView (the unified project IDE at /projects/:id) lives
  // INSIDE AppShell now — chrome stays visible so the user can jump to
  // Agentes / Configurações / etc. without leaving the project. Earlier
  // iterations short-circuited here to give the workspace 100dvh; that
  // mode was retired when the rail + bottom panel + status bar moved
  // INTO the project view itself. If a future surface needs full-bleed,
  // gate on a dedicated page id (e.g. 'fullscreen') instead of 'project'.

  const nav: NavItem[] = [
    { id: 'home', label: t('nav.projects'), icon: Home, href: '/' },
    {
      id: 'apps',
      label: t('nav.apps', { defaultValue: 'Meus apps' }),
      icon: Sparkles,
      href: '/apps',
      show: features.appStudioEnabled,
    },
    { id: 'agents', label: t('nav.agents'), icon: Users, href: '/agents' },
    { id: 'global', label: t('nav.global'), icon: Orbit, href: '/global' },
    {
      id: 'design-systems',
      label: t('nav.designSystems'),
      icon: Palette,
      href: '/design-systems',
      show: features.designSystemEnabled,
    },
    {
      id: 'sprites',
      label: t('nav.sprites'),
      icon: ImagePlay,
      href: '/sprites',
      show: features.spriteStudioEnabled,
    },
    { id: 'telemetry', label: t('nav.telemetry'), icon: Activity, href: '/telemetry' },
    { id: 'docs', label: t('nav.docs'), icon: BookOpen, href: '/docs' },
    { id: 'admin', label: t('nav.admin'), icon: Settings, href: '/admin' },
  ].filter((n) => n.show !== false);

  const commandActions = useMemo(
    () =>
      buildCommandActions({
        nav: nav.map((n) => ({ id: String(n.id), label: n.label, href: n.href, icon: n.icon })),
        projects: projectsData ?? [],
        recent: recentData ?? [],
        navigate,
        toggleTheme: () => setDark((d) => !d),
        toggleLanguage: () =>
          void i18n.changeLanguage(i18n.language?.startsWith('pt') ? 'en' : 'pt-BR'),
        labels: {
          toggleTheme: t('commandPalette.action.toggleTheme'),
          toggleLanguage: t('commandPalette.action.toggleLanguage'),
        },
      }),
    [nav, projectsData, recentData, navigate, i18n, t],
  );

  const shortcut = platform === 'darwin' ? '⌘K' : 'Ctrl K';

  return (
    <div className="h-[100dvh] flex flex-col bg-background text-foreground">
      <header
        className={cn(
          'drag h-9 min-w-0 shrink-0 overflow-hidden border-b bg-card/60 backdrop-blur supports-[backdrop-filter]:bg-card/40 flex items-center px-2 gap-1 transition-opacity',
          isWorkbenchView && 'border-[var(--workbench-border)] bg-[var(--workbench-raised)] supports-[backdrop-filter]:bg-[var(--workbench-raised)]',
          platform === 'darwin' && 'pl-[72px]',
          !isFocused && 'opacity-60',
        )}
      >
        {/* Left: brand doubles as the app menu, then the project breadcrumb */}
        <AppMenu />
        {projectName && view.projectId && (
          <div className="flex min-w-0 items-center gap-1 text-[12px]">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {/* Breadcrumb name doubles as a quick project switcher. `no-drag`
                so the click lands on the popover, not the window-drag region. */}
            <ProjectSwitcher
              currentProjectId={view.projectId}
              projects={projectsData ?? undefined}
              triggerClassName="no-drag flex min-w-0 items-center gap-1 rounded px-1 -mx-0.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
            >
              <span className="truncate max-w-[200px]">{projectName}</span>
              <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </ProjectSwitcher>
          </div>
        )}
        {isAppStudioWorkbench && (
          <div className="no-drag flex min-w-0 items-center gap-1 text-[12px]">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => navigate('/apps')}
              className="flex h-7 items-center gap-1.5 rounded px-1.5 font-medium transition-colors hover:bg-[var(--workbench-hover)]"
            >
              <Sparkles className="h-3.5 w-3.5 text-violet-400" />
              <span>{t('nav.apps', { defaultValue: 'Meus apps' })}</span>
            </button>
          </div>
        )}
        {isCompanyWorkbench && (
          <div className="no-drag flex min-w-0 items-center gap-1 text-[12px]">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => navigate('/agents')}
              className="flex h-7 items-center gap-1.5 rounded px-1.5 font-medium transition-colors hover:bg-[var(--workbench-hover)]"
            >
              <Users className="h-3.5 w-3.5 text-violet-400" />
              <span>{t('nav.agents')}</span>
            </button>
          </div>
        )}
        {isSpriteWorkbench && (
          <div className="no-drag flex min-w-0 items-center gap-1 text-[12px]">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => navigate('/sprites')}
              className="flex h-7 items-center gap-1.5 rounded px-1.5 font-medium transition-colors hover:bg-[var(--workbench-hover)]"
            >
              <ImagePlay className="h-3.5 w-3.5 text-violet-400" />
              <span>{t('nav.sprites')}</span>
            </button>
          </div>
        )}
        {isProjectView && view.projectId && <ProjectBranchControl projectId={view.projectId} />}
        {!isWorkbenchView && <span className="mx-0.5 h-4 w-px bg-border" />}
        {/* Center: primary nav (interactive → carved out of the drag region) */}
        {isWorkbenchView ? (
          <div className="no-drag flex min-w-0 flex-1 justify-center px-3">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label={t('commandPalette.open')}
              className="flex h-7 w-full max-w-md items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)] px-2 text-[11px] text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="truncate">Search Everywhere</span>
              <kbd className="ml-auto rounded bg-[var(--workbench-raised)] px-1 font-sans text-[10px]">{shortcut}</kbd>
            </button>
          </div>
        ) : (
          <nav className="no-drag hidden items-center gap-0.5 md:flex" aria-label={t('nav.primaryAria')}>
            {nav.map((item) => (
              <Fragment key={item.id}>
                {item.id === 'telemetry' && <span className="mx-1 h-4 w-px bg-border" />}
                <NavButton
                  item={item}
                  active={view.page === item.id}
                  onClick={() => navigate(item.href)}
                />
              </Fragment>
            ))}
          </nav>
        )}
        {/* Right cluster */}
        <div className="no-drag ml-auto flex items-center gap-0.5">
          {!isWorkbenchView && <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={t('commandPalette.open')}
            className="mr-1 hidden h-7 items-center gap-2 rounded-md border bg-muted/40 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{t('commandPalette.open')}</span>
            <kbd className="rounded bg-background px-1 font-sans text-[10px] text-muted-foreground">
              {shortcut}
            </kbd>
          </button>}
          {isProjectView && view.projectId && <ProjectRunControl projectId={view.projectId} />}
          {currentPin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => togglePin(currentPin)}
                  aria-label={t(currentPinned ? 'pins:unpinCurrent' : 'pins:pinCurrent')}
                  className="h-7 w-7"
                >
                  {currentPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t(currentPinned ? 'pins:unpinCurrent' : 'pins:pinCurrent')}</TooltipContent>
            </Tooltip>
          )}
          <RunningTasksDropdown />
          <RecentSessionsDropdown
            activeSessionId={view.sessionId}
            onSelect={(projectId, sessionId) =>
              navigate(`/projects/${projectId}${sessionId ? `?session=${sessionId}` : ''}`)
            }
          />
          {!isWorkbenchView && <LanguageSwitcher />}
          <CloudStatusButton />
          {!isWorkbenchView && <Tooltip>
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
          </Tooltip>}
          <WindowControls />
        </div>
      </header>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} actions={commandActions} />
      {/* Global pinned tabs — persists across the whole app; hidden when empty. */}
      <PinnedTabsBar />
      {/* Container padding by route. Pages that own their full-bleed
          surface (agents zones, design-systems gallery, project analytics)
          opt out and manage their own margins. Everything else (home grid,
          admin, docs, telemetry, fallback) gets a comfortable container so
          content doesn't slam against the viewport. */}
      <main
        className={cn(
          'flex-1 min-h-0',
          // Full-bleed surfaces — these own their own padding and (for
          // ProjectView / AgentsTab / DesignSystems) their own
          // resize-panel layout, so AppShell mustn't inject overflow
          // or padding. We also flip `<main>` to flex-column so the
          // route root (which uses h-full internally) gets a proper
          // flex parent; without this the route can collapse to its
          // intrinsic content height and leak the background through
          // the bottom of the viewport.
          view.page === 'project' ||
          view.page === 'agents' ||
          view.page === 'global' ||
          view.page === 'design-systems' ||
          view.page === 'sprites' ||
          // Settings (/admin), Docs (/docs) and Telemetry (/telemetry) own
          // their own padding + a fixed-height, independently-scrolling body
          // under a compact top band (IDE-style), so they opt out of the
          // outer scroll+padding like the other two-pane surfaces above.
          view.page === 'admin' ||
          view.page === 'apps' ||
          view.page === 'docs' ||
          view.page === 'telemetry'
            ? 'flex flex-col overflow-hidden'
            : 'overflow-auto px-6 py-5',
        )}
      >
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
  const { t } = useTranslation();
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
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('recentSessions.tooltip')}>
              <Clock className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('recentSessions.tooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('recentSessions.label')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(!data || data.length === 0) && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t('recentSessions.empty')}
          </div>
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

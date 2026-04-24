import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, ChevronLeft, ChevronRight, FolderGit2, Home, Menu, Moon, Settings, Sun, Users, X } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { DialogProvider } from './components/ui/dialog-provider.js';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './components/ui/tooltip.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import Admin from './features/admin/index.js';
import ProjectDetail from './features/project/index.js';
import { ProjectList } from './features/project/index.js';
import { RecentSessionsList } from './features/recent/RecentSessionsList.js';
import { AgentsTab } from './features/agents/AgentsTab.js';
import { cn } from './lib/utils.js';

type View =
  | { page: 'home' }
  | { page: 'project'; id: number; name: string; sessionId?: number }
  | { page: 'admin' }
  | { page: 'agents' };

function NavButton({
  icon,
  label,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
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

export default function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ page: 'home' });
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

  return (
    <TooltipProvider delayDuration={300}>
    <DialogProvider>
    <div className="min-h-screen bg-background text-foreground">
      <div className={cn(
        'grid grid-cols-1 min-h-screen',
        sidebarCollapsed ? 'md:grid-cols-[60px_1fr]' : 'md:grid-cols-[260px_1fr]',
      )}>
        {/* Sidebar */}
        <aside className={cn(
          'flex flex-col border-r bg-card',
          'fixed inset-y-0 left-0 z-40 transition-all duration-200',
          'md:relative md:translate-x-0 md:z-auto',
          sidebarCollapsed ? 'md:w-[60px]' : 'md:w-auto',
          mobileSidebarOpen ? 'translate-x-0 w-64' : '-translate-x-full w-64',
        )}>
          <button
            className="md:hidden absolute top-3 right-3 p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
          <div className={cn(
            'h-16 flex items-center border-b',
            sidebarCollapsed ? 'justify-center px-2' : 'gap-2.5 px-5',
          )}>
            <div className="h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-sm shrink-0">
              <Boxes className="h-5 w-5" />
            </div>
            {!sidebarCollapsed && (
              <div className="flex flex-col leading-tight">
                <span className="font-semibold text-sm">MCP Indexer</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">v{__APP_VERSION__}</span>
              </div>
            )}
          </div>
          <nav className={cn('flex-1 p-3 space-y-1 overflow-hidden', sidebarCollapsed && 'px-1.5')}>
            <NavButton
              icon={<Home className="h-4 w-4 shrink-0" />}
              label={t('nav.projects')}
              active={view.page === 'home'}
              collapsed={sidebarCollapsed}
              onClick={() => { setView({ page: 'home' }); setMobileSidebarOpen(false); }}
            />
            <NavButton
              icon={<Users className="h-4 w-4 shrink-0" />}
              label={t('nav.agents')}
              active={view.page === 'agents'}
              collapsed={sidebarCollapsed}
              onClick={() => { setView({ page: 'agents' }); setMobileSidebarOpen(false); }}
            />
            <NavButton
              icon={<Settings className="h-4 w-4 shrink-0" />}
              label={t('nav.admin')}
              active={view.page === 'admin'}
              collapsed={sidebarCollapsed}
              onClick={() => { setView({ page: 'admin' }); setMobileSidebarOpen(false); }}
            />
            {!sidebarCollapsed && view.page === 'project' && (
              <div className="px-3 py-2 rounded-lg bg-primary/10 text-primary flex items-center gap-2 text-sm font-medium">
                <FolderGit2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{view.name}</span>
              </div>
            )}
            {!sidebarCollapsed && (
              <RecentSessionsList
                activeSessionId={view.page === 'project' ? view.sessionId ?? null : null}
                onSelect={(id, name, sessionId) => setView({ page: 'project', id, name, sessionId })}
              />
            )}
          </nav>
          <div className={cn(
            'border-t flex flex-col',
            sidebarCollapsed ? 'p-1.5 items-center' : 'p-3',
          )}>
            {!sidebarCollapsed && (
              <div className="px-3 mb-1 text-[10px] text-muted-foreground">
                <div>{t('footer.title')} Dashboard</div>
                <div className="opacity-60">© 2026</div>
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    'hidden md:flex items-center justify-center rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors',
                    !sidebarCollapsed && 'w-full',
                  )}
                  onClick={toggleCollapsed}
                  aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
              </TooltipContent>
            </Tooltip>
          </div>
        </aside>

        {/* Main */}
        <div className="flex flex-col min-w-0">
          {/* Topbar */}
          <header className="h-16 border-b bg-card/60 backdrop-blur sticky top-0 z-30 flex items-center px-4 gap-3">
            <button
              className="md:hidden p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              onClick={() => setMobileSidebarOpen(true)}
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <button
              onClick={() => setView({ page: 'home' })}
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('nav.dashboard')}
            </button>
            {view.page === 'project' && (
              <>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold truncate">{view.name}</span>
              </>
            )}
            {view.page === 'agents' && (
              <>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t('nav.agents')}</span>
              </>
            )}
            {view.page === 'admin' && (
              <>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold">{t('nav.admin')}</span>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <LanguageSwitcher />
              <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} title={t('theme.toggle')}>
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </div>
          </header>

          {/* Content */}
          <main className={cn(
            'flex-1 w-full mx-auto',
            view.page !== 'agents' && 'px-3 py-4 sm:px-6 sm:py-6',
          )}>
            {view.page === 'home' && (
              <ProjectList onSelectProject={(id, name) => setView({ page: 'project', id, name })} />
            )}
            {view.page === 'project' && (
              <ProjectDetail
                projectId={view.id}
                projectName={view.name}
                initialSessionId={view.sessionId}
              />
            )}
            {view.page === 'agents' && <AgentsTab />}
            {view.page === 'admin' && <Admin />}
          </main>
        </div>
      </div>
      {/* Mobile sidebar backdrop */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
    </div>
    </DialogProvider>
    </TooltipProvider>
  );
}

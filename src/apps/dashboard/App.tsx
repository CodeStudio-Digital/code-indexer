import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, ChevronRight, FolderGit2, Home, Menu, Moon, Settings, Sun, Users, X } from 'lucide-react';
import { Button } from './components/ui/button.js';
import { DialogProvider } from './components/ui/dialog-provider.js';
import { TooltipProvider } from './components/ui/tooltip.js';
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

export default function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ page: 'home' });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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

  return (
    <TooltipProvider delayDuration={300}>
    <DialogProvider>
    <div className="min-h-screen bg-background text-foreground">
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] min-h-screen">
        {/* Sidebar */}
        <aside className={cn(
          'flex flex-col border-r bg-card',
          'fixed inset-y-0 left-0 w-64 z-40 transition-transform duration-200',
          'md:relative md:translate-x-0 md:z-auto md:w-auto',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <button
            className="md:hidden absolute top-3 right-3 p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="h-16 flex items-center gap-2.5 px-5 border-b">
            <div className="h-9 w-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
              <Boxes className="h-5 w-5" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-semibold text-sm">MCP Indexer</span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">v{__APP_VERSION__}</span>
            </div>
          </div>
          <nav className="flex-1 p-3 space-y-1">
            <button
              onClick={() => { setView({ page: 'home' }); setMobileSidebarOpen(false); }}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                view.page === 'home'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Home className="h-4 w-4" />
              {t('nav.projects')}
            </button>
            {view.page === 'project' && (
              <div className="px-3 py-2 rounded-lg bg-primary/10 text-primary flex items-center gap-2 text-sm font-medium">
                <FolderGit2 className="h-4 w-4" />
                <span className="truncate">{view.name}</span>
              </div>
            )}
            <RecentSessionsList
              activeSessionId={view.page === 'project' ? view.sessionId ?? null : null}
              onSelect={(id, name, sessionId) => setView({ page: 'project', id, name, sessionId })}
            />
            <button
              onClick={() => { setView({ page: 'agents' }); setMobileSidebarOpen(false); }}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                view.page === 'agents'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Users className="h-4 w-4" />
              {t('nav.agents')}
            </button>
            <button
              onClick={() => { setView({ page: 'admin' }); setMobileSidebarOpen(false); }}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                view.page === 'admin'
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Settings className="h-4 w-4" />
              {t('nav.admin')}
            </button>
          </nav>
          <div className="p-3 border-t text-[10px] text-muted-foreground">
            <div className="px-3">{t('footer.title')} Dashboard</div>
            <div className="px-3 opacity-60">© 2026</div>
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
          <main className="flex-1 px-3 py-4 sm:px-6 sm:py-6 w-full mx-auto">
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

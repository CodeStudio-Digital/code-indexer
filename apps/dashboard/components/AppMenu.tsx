import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, BookOpen, ChevronDown, Home, Info, LogOut, Orbit, Settings, Sparkles, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import { AboutDialog } from './AboutDialog.js';
import { useWindowChrome } from '../hooks/useWindowChrome.js';

/**
 * The brand logo doubles as the application menu (replacing the hidden
 * native menu bar). Items: About, Settings, Documentation, and — inside
 * Electron only — Quit (which exits the whole app, not just the window).
 */
export function AppMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isElectron } = useWindowChrome();
  const [aboutOpen, setAboutOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('appMenu.menuAria')}
            className="no-drag inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12px] font-semibold text-foreground hover:bg-muted"
          >
            <img src="/brand/logo-mark.svg" alt="" className="h-5 w-5 shrink-0" draggable={false} />
            <span>CodeStudio</span>
            <span className="text-[9px] font-normal uppercase tracking-wider text-muted-foreground">
              v{__APP_VERSION__}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => navigate('/')}>
            <Home />
            {t('nav.projects')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/apps')}>
            <Sparkles />
            {t('nav.apps', { defaultValue: 'Meus apps' })}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/agents')}>
            <Users />
            {t('nav.agents')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/global')}>
            <Orbit />
            {t('nav.global')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/telemetry')}>
            <Activity />
            {t('nav.telemetry')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info />
            {t('appMenu.about')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            <Settings />
            {t('appMenu.settings')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/docs')}>
            <BookOpen />
            {t('appMenu.docs')}
          </DropdownMenuItem>
          {isElectron && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.electronAPI?.windowControls.quit()}>
                <LogOut />
                {t('appMenu.quit')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AboutDialog
        open={aboutOpen}
        onOpenChange={setAboutOpen}
        onDocs={() => {
          setAboutOpen(false);
          navigate('/docs');
        }}
      />
    </>
  );
}

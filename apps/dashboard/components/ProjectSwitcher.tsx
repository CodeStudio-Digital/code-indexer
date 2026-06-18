/**
 * Quick project switcher — a searchable popover over the user's projects,
 * surfaced anywhere the active project name is shown (title-bar breadcrumb
 * and the bottom StatusBar). Click the trigger → type to filter →
 * Enter / click to jump to `/projects/:id`. Keyboard-first (↑/↓/Enter/Esc),
 * mirroring the ⌘K command palette.
 *
 * The trigger's visual is injected by the caller as `children` (each mount
 * styles its own chip); the popover, search input, list, and all visible
 * copy live here behind `t()` so no caller needs new literals.
 *
 * Fetch is lazy: `/projects` is only hit on first open unless the caller
 * already has the list (AppShell) and passes it via `projects` — useApi has
 * no shared cache, so this avoids a duplicate request per mount site.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, FolderGit2, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { useApi } from '../hooks/useApi.js';
import { cn } from '../lib/utils.js';

interface ProjectLite {
  id: number;
  name: string;
  root_path?: string;
}

interface ProjectSwitcherProps {
  currentProjectId: number;
  /** Visual content of the trigger (project name chip) — styled by caller. */
  children: React.ReactNode;
  triggerClassName?: string;
  /** Pre-fetched list (AppShell already has it); omit to fetch lazily on open. */
  projects?: ProjectLite[];
  /** StatusBar sits at the very bottom → open upward. */
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  contentClassName?: string;
}

export function ProjectSwitcher({
  currentProjectId,
  children,
  triggerClassName,
  projects: provided,
  side = 'bottom',
  align = 'start',
  contentClassName,
}: ProjectSwitcherProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const { data: fetched } = useApi<ProjectLite[]>(open && !provided ? '/projects' : '');
  const projects = provided ?? fetched ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.root_path?.toLowerCase().includes(q) ?? false),
    );
  }, [projects, query]);

  // Fresh search on every open; land the cursor on the current project so
  // ↑/↓ start from "where you are". While filtering, snap to the top hit.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  useEffect(() => {
    if (query) {
      setActive(0);
      return;
    }
    const idx = filtered.findIndex((p) => p.id === currentProjectId);
    setActive(Math.max(0, idx));
  }, [filtered, query, currentProjectId]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const select = (id: number): void => {
    setOpen(false);
    if (id !== currentProjectId) navigate(`/projects/${id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = filtered[active];
      if (p) select(p.id);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('projectSwitcher.trigger')} className={triggerClassName}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className={cn('w-72 p-0 overflow-hidden', contentClassName)}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projectSwitcher.placeholder')}
            className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('projectSwitcher.empty')}
            </div>
          )}
          {filtered.map((p, i) => {
            const isActive = i === active;
            const isCurrent = p.id === currentProjectId;
            return (
              <button
                key={p.id}
                type="button"
                ref={isActive ? activeRef : undefined}
                onMouseMove={() => setActive(i)}
                onClick={() => select(p.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
                  isActive ? 'bg-accent text-accent-foreground' : 'text-foreground',
                )}
              >
                <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{p.name}</span>
                  {p.root_path && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {p.root_path}
                    </span>
                  )}
                </span>
                {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

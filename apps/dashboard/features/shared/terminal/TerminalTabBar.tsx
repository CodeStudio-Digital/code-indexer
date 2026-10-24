/**
 * Shared tab bar for multi-terminal panels.
 *
 * Renders one tab per session + a "+" button + an optional right-cluster
 * (restart, etc.). The `+` button is the chevron-down menu when the
 * caller wants to offer multiple spawn targets (host vs sandbox vs
 * each project); single-target callers just pass `onAdd`.
 */
import { ChevronDown, Plus, RotateCcw, TerminalSquare, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalSession } from '../../../state/terminal-sessions.js';
import type { TerminalShell } from '../../../state/terminal-shell-prefs.js';
import { cn } from '../../../lib/utils.js';

export interface SpawnTargetOption {
  id: string;
  label: string;
  hint?: string;
}

interface TerminalTabBarProps {
  sessions: TerminalSession[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Single-target spawn — caller decides what kind of PTY. */
  onAdd?: () => void;
  /**
   * Multi-target spawn — when the caller can spawn different kinds of
   * PTYs (host vs each project vs sandbox), pass the option list and
   * the click handler. The bar renders a chevron next to "+" that
   * pops a small menu.
   */
  spawnOptions?: SpawnTargetOption[];
  onAddWithTarget?: (optionId: string) => void;
  onRestart?: () => void;
  addDisabled?: boolean;
  /**
   * Available shells for the picker (detected + custom). When provided,
   * the bar renders a shell pill that drives which shell "+" spawns.
   */
  shellOptions?: TerminalShell[];
  /** Currently selected shell id. */
  activeShellId?: string;
  /** Pick a different shell — caller persists it as the new preferred. */
  onSelectShell?: (id: string) => void;
  /** "Adicionar shell…" — caller prompts for a custom executable path. */
  onAddCustomShell?: () => void;
}

export function TerminalTabBar({
  sessions,
  activeId,
  onSelect,
  onClose,
  onAdd,
  spawnOptions,
  onAddWithTarget,
  onRestart,
  addDisabled,
  shellOptions,
  activeShellId,
  onSelectShell,
  onAddCustomShell,
}: TerminalTabBarProps) {
  const hasMenu = !!spawnOptions && spawnOptions.length > 0 && !!onAddWithTarget;
  const hasShellPicker = !!shellOptions && shellOptions.length > 0 && !!onSelectShell;
  const activeShell = hasShellPicker
    ? (shellOptions!.find((s) => s.id === activeShellId) ?? shellOptions![0])
    : undefined;

  // Both dropdowns render in a portal anchored to their trigger button.
  // The tab bar's `overflow-x-auto` (needed for tab scrolling) would clip
  // an in-flow dropdown, so we float them over everything via `fixed` coords
  // and flip upward when the terminal panel sits too low for a downward menu.
  const shellBtnRef = useRef<HTMLButtonElement>(null);
  const targetBtnRef = useRef<HTMLButtonElement>(null);
  const [shellMenu, setShellMenu] = useState<MenuPos | null>(null);
  const [targetMenu, setTargetMenu] = useState<MenuPos | null>(null);

  const openShellMenu = (): void => {
    if (shellMenu) return setShellMenu(null);
    const itemCount = shellOptions!.length + (onAddCustomShell ? 1 : 0);
    setShellMenu(computeMenuPos(shellBtnRef.current, itemCount, 32, 'right'));
  };
  const openTargetMenu = (): void => {
    if (targetMenu) return setTargetMenu(null);
    // Target rows show label + hint, so they're taller (~44px each).
    setTargetMenu(computeMenuPos(targetBtnRef.current, spawnOptions!.length, 44, 'left'));
  };

  return (
    <div className="h-7 shrink-0 border-b flex items-center px-1 gap-0.5 bg-card/50 overflow-x-auto relative">
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        return (
          <div
            key={s.id}
            className={cn(
              'group inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-sm text-[11px] cursor-pointer shrink-0 transition-colors',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
            )}
            onClick={() => onSelect(s.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(s.id);
              }
            }}
            title={`${s.name} · ${new Date(s.createdAt).toLocaleTimeString()}${
              s.target ? ` · ${describeTarget(s.target)}` : ''
            }`}
          >
            <TerminalSquare
              className={cn(
                'h-3 w-3 shrink-0',
                isActive ? 'text-primary' : 'text-muted-foreground/70',
              )}
            />
            <span className="font-medium">{s.name}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(s.id);
              }}
              className="ml-1 h-4 w-4 rounded-sm grid place-items-center hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label={`Close ${s.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      <div className="inline-flex items-center">
        <button
          type="button"
          onClick={() => onAdd?.()}
          disabled={addDisabled}
          className="h-6 w-6 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          aria-label="New terminal"
          title={hasMenu ? 'Novo terminal (último target). Use o ▾ para escolher.' : 'New terminal'}
        >
          <Plus className="h-3 w-3" />
        </button>
        {hasMenu && (
          <button
            ref={targetBtnRef}
            type="button"
            onClick={openTargetMenu}
            disabled={addDisabled}
            className="h-6 w-4 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
            aria-label="Escolher target do terminal"
            title="Escolher Host / Sandbox / projeto"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>

      {hasMenu &&
        targetMenu &&
        createPortal(
          <>
            {/* Click-outside scrim so a stray click anywhere collapses the menu. */}
            <div className="fixed inset-0 z-[90]" onClick={() => setTargetMenu(null)} />
            <div
              className="fixed z-[91] min-w-[200px] max-h-[300px] overflow-y-auto border bg-popover text-popover-foreground rounded-md shadow-lg py-1 text-[12px]"
              style={{ top: targetMenu.top, bottom: targetMenu.bottom, left: targetMenu.left, right: targetMenu.right }}
            >
              {spawnOptions!.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors"
                  onClick={() => {
                    setTargetMenu(null);
                    onAddWithTarget!(opt.id);
                  }}
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.hint && (
                    <div className="text-[10.5px] text-muted-foreground">{opt.hint}</div>
                  )}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}

      {/* Right-side cluster: shell picker + restart active session. */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0 relative">
        {hasShellPicker && (
          <button
            ref={shellBtnRef}
            type="button"
            onClick={openShellMenu}
            className="h-6 inline-flex items-center gap-1 px-2 rounded-sm text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            title="Escolher shell (PowerShell, WSL, Git Bash, cmd…)"
          >
            <TerminalSquare className="h-3 w-3" />
            <span className="max-w-[140px] truncate">{activeShell?.label ?? 'Shell'}</span>
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
        {hasShellPicker &&
          shellMenu &&
          createPortal(
            <>
              <div className="fixed inset-0 z-[90]" onClick={() => setShellMenu(null)} />
              <div
                className="fixed z-[91] min-w-[220px] max-h-[300px] overflow-y-auto border bg-popover text-popover-foreground rounded-md shadow-lg py-1 text-[12px]"
                style={{ top: shellMenu.top, bottom: shellMenu.bottom, right: shellMenu.right }}
              >
                {shellOptions!.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={cn(
                      'w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-center gap-2',
                      opt.id === activeShell?.id && 'text-primary',
                    )}
                    onClick={() => {
                      setShellMenu(null);
                      onSelectShell!(opt.id);
                    }}
                  >
                    <TerminalSquare className="h-3 w-3 shrink-0 opacity-70" />
                    <span className="truncate">{opt.label}</span>
                  </button>
                ))}
                {onAddCustomShell && (
                  <>
                    <div className="my-1 border-t" />
                    <button
                      type="button"
                      className="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors flex items-center gap-2 text-muted-foreground"
                      onClick={() => {
                        setShellMenu(null);
                        onAddCustomShell();
                      }}
                    >
                      <Plus className="h-3 w-3 shrink-0" />
                      <span>Adicionar shell…</span>
                    </button>
                  </>
                )}
              </div>
            </>,
            document.body,
          )}
        {activeId && onRestart && (
          <button
            type="button"
            onClick={onRestart}
            className="h-6 w-6 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            aria-label="Restart active terminal"
            title="Restart the active terminal (kills its PTY and spawns a fresh shell)"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface MenuPos {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/**
 * Fixed-position coords for a portal dropdown anchored to `el`. Aligns to
 * the button's left or right edge and flips upward when a downward menu
 * wouldn't fit (the terminal panel sits low on screen). Returns viewport
 * coords for `position: fixed`, escaping the tab bar's overflow clip.
 */
function computeMenuPos(
  el: HTMLElement | null,
  itemCount: number,
  itemHeight: number,
  align: 'left' | 'right',
): MenuPos {
  if (!el) return { top: 0, right: 0 };
  const r = el.getBoundingClientRect();
  const estHeight = Math.min(itemCount * itemHeight + 12, 300);
  const openUp = r.bottom + estHeight > window.innerHeight - 8;
  const vertical = openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 };
  const horizontal = align === 'right' ? { right: window.innerWidth - r.right } : { left: r.left };
  return { ...vertical, ...horizontal };
}

function describeTarget(target: NonNullable<TerminalSession['target']>): string {
  switch (target.kind) {
    case 'host':
      return 'Host';
    case 'project':
      return `Projeto #${target.projectId}`;
    case 'sandbox':
      return `Sandbox sessão #${target.sessionId}`;
  }
}

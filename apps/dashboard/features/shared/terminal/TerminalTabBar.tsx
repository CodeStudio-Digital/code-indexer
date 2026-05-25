/**
 * Shared tab bar for multi-terminal panels.
 *
 * Renders one tab per session + a "+" button + an optional right-cluster
 * (restart, etc.). The `+` button is the chevron-down menu when the
 * caller wants to offer multiple spawn targets (host vs sandbox vs
 * each project); single-target callers just pass `onAdd`.
 */
import { ChevronDown, Plus, RotateCcw, TerminalSquare, X } from 'lucide-react';
import { useState } from 'react';
import type { TerminalSession } from '../../../state/terminal-sessions.js';
import { cn } from '../../../lib/utils.js';

export interface SpawnTargetOption {
  id: string;
  label: string;
  hint?: string;
}

export interface TerminalTabBarProps {
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
}: TerminalTabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const hasMenu = !!spawnOptions && spawnOptions.length > 0 && !!onAddWithTarget;

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
          onClick={() => {
            if (hasMenu) setMenuOpen((v) => !v);
            else onAdd?.();
          }}
          disabled={addDisabled}
          className="h-6 w-6 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
          aria-label="New terminal"
          title="New terminal"
        >
          <Plus className="h-3 w-3" />
        </button>
        {hasMenu && (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={addDisabled}
            className="h-6 w-3 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
            aria-label="Pick spawn target"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      </div>

      {hasMenu && menuOpen && (
        <>
          {/* Click-outside scrim so a stray click anywhere collapses the menu. */}
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute left-12 top-7 z-50 min-w-[200px] border bg-popover text-popover-foreground rounded-md shadow-md py-1 text-[12px]">
            {spawnOptions!.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors"
                onClick={() => {
                  setMenuOpen(false);
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
        </>
      )}

      {/* Right-side cluster: restart active session. */}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">
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

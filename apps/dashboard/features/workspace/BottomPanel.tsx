/**
 * Bottom panel — VS Code-style collapsible drawer with tabs.
 *
 * Day 6: skeleton with tab bar but every tab is a placeholder.
 * Day 10 wires the Terminal tab to apiStream('terminal.output', …).
 * Problems/Output/Search arrive as features get built (or stay
 * placeholders until needed).
 */

import { useState } from 'react';
import {
  TerminalSquare,
  AlertCircle,
  FileText,
  Search,
  ChevronDown,
  ChevronUp,
  X,
  Puzzle,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { ErrorBoundary } from '../../components/ErrorBoundary.js';
import { WorkspaceTerminal } from './WorkspaceTerminal.js';
import { WebviewWindow } from './jetbrains/tool-windows/WebviewWindow.js';
import type { ContribToolWindow } from '../../state/contribution-registry.js';
import { ProblemsPanel } from '../project/bottom/ProblemsPanel.js';
import { OutputPanel } from '../project/bottom/OutputPanel.js';
import { FindPanel } from '../project/bottom/FindPanel.js';
import { useProjectDiagnostics } from '../project/bottom/useProjectDiagnostics.js';

type BuiltinTabId = 'terminal' | 'problems' | 'output' | 'find';

const TABS: Array<{ id: BuiltinTabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'problems', label: 'Problems', icon: AlertCircle },
  { id: 'output', label: 'Output', icon: FileText },
  { id: 'find', label: 'Find', icon: Search },
];

interface BottomPanelProps {
  projectId: number;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Open a file in the editor (used by Problems rows to jump to a problem). */
  onOpenFile?: (path: string) => void;
  /** Plugin tool windows that declared `side: 'bottom'` — appended as tabs. */
  pluginWindows?: ContribToolWindow[];
}

export function BottomPanel({
  projectId,
  isOpen,
  onToggle,
  onClose,
  onOpenFile,
  pluginWindows = [],
}: BottomPanelProps) {
  // `tab` is an open string so plugin window ids (not in BuiltinTabId) can win.
  const [tab, setTab] = useState<string>('terminal');
  const activePlugin = pluginWindows.find((w) => w.id === tab);
  // Live count drives the Problems tab badge even while that tab is inactive.
  const diagnostics = useProjectDiagnostics(projectId);
  const problemCount = diagnostics.errorCount + diagnostics.warningCount;

  return (
    <div className="h-full flex flex-col bg-card/40 border-t min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center px-1 gap-0.5">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
          {TABS.map((def) => {
            const Icon = def.icon;
            const active = tab === def.id;
            return (
              <button
                key={def.id}
                type="button"
                onClick={() => {
                  setTab(def.id);
                  if (!isOpen) onToggle();
                }}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-3 w-3" />
                <span>{def.label}</span>
                {def.id === 'problems' && problemCount > 0 && (
                  <span
                    className={cn(
                      'ml-0.5 min-w-[16px] rounded px-1 text-[10px] leading-4 text-center tabular-nums',
                      diagnostics.errorCount > 0
                        ? 'bg-red-500/15 text-red-500'
                        : 'bg-amber-500/15 text-amber-500',
                    )}
                  >
                    {problemCount}
                  </span>
                )}
              </button>
            );
          })}
          {pluginWindows.map((w) => {
            const active = tab === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  setTab(w.id);
                  if (!isOpen) onToggle();
                }}
                title={w.title}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                <Puzzle className="h-3 w-3" />
                <span className="truncate max-w-[120px]">{w.title}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggle}
            aria-label={isOpen ? 'Collapse panel' : 'Expand panel'}
          >
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label="Close panel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {isOpen && (
        <div className="flex-1 min-h-0 overflow-hidden">
          {/* Contain a crash to the active tab — a broken panel shows an inline
              message instead of taking down the whole workspace. Keyed by tab so
              switching tabs clears a stuck error. */}
          <ErrorBoundary label={tab} resetKey={tab}>
            {tab === 'terminal' && <WorkspaceTerminal projectId={projectId} />}
            {tab === 'problems' && !activePlugin && (
              <ProblemsPanel items={diagnostics.items} onOpenFile={onOpenFile} />
            )}
            {tab === 'output' && !activePlugin && <OutputPanel projectId={projectId} />}
            {tab === 'find' && !activePlugin && (
              <FindPanel projectId={projectId} onOpenFile={onOpenFile} />
            )}
            {activePlugin && (
              <WebviewWindow
                namespace={activePlugin.pluginNs}
                title={activePlugin.title}
                entry={activePlugin.entry}
                projectId={projectId}
              />
            )}
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}

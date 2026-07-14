/**
 * Bottom panel — VS Code-style collapsible drawer with tabs.
 *
 * Day 6: skeleton with tab bar but every tab is a placeholder.
 * Day 10 wires the Terminal tab to apiStream('terminal.output', …).
 * Problems/Output/Search arrive as features get built (or stay
 * placeholders until needed).
 */

import { Suspense, lazy, useState } from 'react';
import {
  TerminalSquare,
  AlertCircle,
  FileText,
  Search,
  Play,
  Loader2,
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
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { ProblemsPanel } from '../project/bottom/ProblemsPanel.js';
import { OutputPanel } from '../project/bottom/OutputPanel.js';
import { FindPanel } from '../project/bottom/FindPanel.js';
import { useProjectDiagnostics } from '../project/bottom/useProjectDiagnostics.js';

// Runners é uma aba pesada (xterm + detect): vira chunk LAZY, baixado só
// quando o usuário abre a aba — não pesa no chunk inicial do ProjectView.
const RunnersTab = lazy(() =>
  import('../project/tabs/RunnersTab.js').then((m) => ({ default: m.RunnersTab })),
);

type BuiltinTabId = 'terminal' | 'problems' | 'output' | 'find' | 'runners';

const TABS: Array<{ id: BuiltinTabId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'runners', label: 'Runners', icon: Play },
  { id: 'problems', label: 'Problems', icon: AlertCircle },
  { id: 'output', label: 'Output', icon: FileText },
  { id: 'find', label: 'Find', icon: Search },
];

/** Built-in bottom-panel tab ids — used by the ProjectView deep-link
 *  handler to route `?tab=runners` (etc.) into the bottom drawer instead
 *  of a side-rail tab. */
export const BOTTOM_BUILTIN_TAB_IDS = new Set<string>(TABS.map((t) => t.id));

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
  // A aba ativa do drawer É o `activeBottom` do layout store (fonte única) — assim
  // o deep-link `?tab=runners` e o dropdown global de tasks abrem a aba certa só
  // mexendo no store. Fallback 'terminal' nunca acontece na prática: o BottomPanel
  // só monta quando activeBottom é não-nulo.
  const activeBottom = useWorkspaceLayout((s) => s.activeBottom);
  const setActiveBottom = useWorkspaceLayout((s) => s.setActiveBottom);
  const tab = activeBottom ?? 'terminal';
  // Gate (W2/P3): só assinamos o diagnostics stream depois que o usuário abre Problems
  // pela 1ª vez (e o mantemos ligado para o badge). Antes disso, durante a indexação,
  // o despejo de frames não toca a UI.
  const [seenProblems, setSeenProblems] = useState(false);
  const activePlugin = pluginWindows.find((w) => w.id === tab);
  const diagnostics = useProjectDiagnostics(projectId, tab === 'problems' || seenProblems);
  const problemCount = diagnostics.errorCount + diagnostics.warningCount;

  return (
    <div className="h-full flex flex-col bg-[var(--workbench-surface)] min-h-0">
      <div className="h-8 shrink-0 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] flex items-center px-1 gap-0.5">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
          {TABS.map((def) => {
            const Icon = def.icon;
            const active = tab === def.id;
            return (
              <button
                key={def.id}
                type="button"
                onClick={() => {
                  setActiveBottom(def.id);
                  if (def.id === 'problems') setSeenProblems(true);
                  if (!isOpen) onToggle();
                }}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
                  active
                    ? 'bg-[var(--workbench-active)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--workbench-hover)]',
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
                  setActiveBottom(w.id);
                  if (!isOpen) onToggle();
                }}
                title={w.title}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors',
                  active
                    ? 'bg-[var(--workbench-active)] text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--workbench-hover)]',
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
            {tab === 'runners' && !activePlugin && (
              <Suspense
                fallback={
                  <div className="h-full grid place-items-center">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                }
              >
                <RunnersTab projectId={projectId} />
              </Suspense>
            )}
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

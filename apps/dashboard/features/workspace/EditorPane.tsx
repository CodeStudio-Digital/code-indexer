/**
 * Editor pane host + per-pane view.
 *
 * `EditorPaneHost` lays out one or two editor panes (IntelliJ-style split):
 * single → a bare `EditorPaneView`; split → two views in a resizable
 * `PanelGroup` (row = side-by-side, column = stacked). Each `EditorPaneView`
 * is a self-contained editor area: its own tab bar + the Monaco mount (or a
 * diff/git/merge/markdown/drawio surface) for that pane's active tab.
 *
 * Monaco itself is lazy-loaded (Suspense fallback) so the ~5 MB gzipped chunk
 * only lands when the user actually opens a file.
 */

import { Suspense, lazy, useCallback, useEffect, useReducer } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  FileCode2,
  FilePlus2,
  Loader2,
  MessageSquare,
  MousePointerSquareDashed,
  Search,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { EditorTabBar } from './EditorTabBar.js';
import { ExternalChangeBanner } from './ExternalChangeBanner.js';
import { executeCommand, getCommand, onCommandsChanged } from '../../keymap/commands.js';
import { useKeymapStore, bindingLabel } from '../../keymap/keymap-store.js';

const MonacoMount = lazy(() =>
  import('./editor/MonacoMount.js').then((m) => ({ default: m.MonacoMount })),
);
const LspInstallPrompt = lazy(() =>
  import('./editor/LspInstallPrompt.js').then((m) => ({ default: m.LspInstallPrompt })),
);
const DiffMount = lazy(() =>
  import('./editor/DiffMount.js').then((m) => ({ default: m.DiffMount })),
);
const MarkdownView = lazy(() =>
  import('./editor/MarkdownView.js').then((m) => ({ default: m.MarkdownView })),
);
const DrawioEditor = lazy(() =>
  import('./editor/DrawioEditor.js').then((m) => ({ default: m.DrawioEditor })),
);
const GitLogView = lazy(() =>
  import('./jetbrains/tool-windows/git/GitLogView.js').then((m) => ({ default: m.GitLogView })),
);
const StashDetailView = lazy(() =>
  import('./jetbrains/tool-windows/git/StashDetailView.js').then((m) => ({ default: m.StashDetailView })),
);
const MergeTabView = lazy(() =>
  import('./editor/merge/MergeTabView.js').then((m) => ({ default: m.MergeTabView })),
);
const SftpEditMount = lazy(() =>
  import('../ssh/sftp/SftpEditMount.js').then((m) => ({ default: m.SftpEditMount })),
);

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function isDrawioPath(path: string): boolean {
  return /\.drawio$/i.test(path);
}

/**
 * Host: renders a single pane, or two panes in a resizable split. The split
 * lives entirely inside the editor area — it nests under ProjectView's existing
 * chat/terminal PanelGroups.
 */
export function EditorPaneHost() {
  const panes = useWorkspaceStore((s) => s.panes);
  const splitDir = useWorkspaceStore((s) => s.splitDir);

  if (!splitDir || panes.length < 2) {
    return <EditorPaneView paneId={panes[0]?.id ?? 'pane'} />;
  }

  const direction = splitDir === 'row' ? 'horizontal' : 'vertical';
  return (
    // key by direction so re-orienting cleanly remounts the group (the library
    // doesn't support changing `direction` on a live instance).
    <PanelGroup
      key={direction}
      direction={direction}
      autoSaveId={`mcp-editor-split-${direction}`}
      className="h-full min-h-0"
    >
      <Panel id="pane-a" order={1} minSize={20} className="min-w-0 min-h-0">
        <EditorPaneView key={panes[0].id} paneId={panes[0].id} />
      </Panel>
      <PanelResizeHandle
        className={cn(
          'bg-border hover:bg-primary/40 transition-colors',
          direction === 'horizontal' ? 'w-px' : 'h-px',
        )}
      />
      <Panel id="pane-b" order={2} minSize={20} className="min-w-0 min-h-0">
        <EditorPaneView key={panes[1].id} paneId={panes[1].id} />
      </Panel>
    </PanelGroup>
  );
}

/** A single editor area — tab bar + the surface for this pane's active tab. */
function EditorPaneView({ paneId }: { paneId: string }) {
  const pane = useWorkspaceStore((s) => s.panes.find((p) => p.id === paneId));
  const isActivePane = useWorkspaceStore((s) => s.activePaneId === paneId);
  const isSplit = useWorkspaceStore((s) => s.splitDir !== null);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);

  // Select THIS pane's active file directly (not the whole pool). `find` returns
  // the existing object reference, and setContent only clones the EDITED file —
  // so when the other pane is typed in, this selector returns the same reference
  // and Zustand's Object.is equality skips re-rendering the idle pane entirely.
  const activePath = pane?.activePath ?? null;
  const activeFile = useWorkspaceStore(
    (s) => s.openFiles.find((f) => f.path === activePath && f.projectId === s.activeProjectId) ?? null,
  );

  // Stable callback so MonacoMount's handleMount deps / props don't churn.
  const onFocusPane = useCallback(() => setActivePane(paneId), [setActivePane, paneId]);

  return (
    <div
      className={cn(
        'h-full flex flex-col bg-background min-h-0 relative',
        // Focused-pane affordance (only meaningful when split).
        isSplit && isActivePane && 'ring-1 ring-inset ring-primary/40',
      )}
      // mousedown (capture) so the pane focuses before the editor steals focus.
      onMouseDownCapture={() => {
        if (!isActivePane) setActivePane(paneId);
      }}
      data-pane-id={paneId}
    >
      <EditorTabBar paneId={paneId} />
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {activeFile ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading editor…</span>
              </div>
            }
          >
            {activeFile.kind === 'git-log' ? (
              <GitLogView tab={activeFile} />
            ) : activeFile.kind === 'git-stash' ? (
              <StashDetailView tab={activeFile} />
            ) : activeFile.kind === 'merge' ? (
              // Key by path: a fresh instance per merged file so switching
              // between two merge tabs never mounts the old file's content
              // (and stale Apply target) under the new file's URI.
              <MergeTabView key={activeFile.path} tab={activeFile} />
            ) : activeFile.kind === 'diff' ? (
              <DiffMount diff={activeFile} />
            ) : activeFile.kind === 'sftp' ? (
              // Remote file edited in-place (download→edit→upload→discard, in memory).
              <SftpEditMount key={activeFile.path} tab={activeFile} />
            ) : isDrawioPath(activeFile.path) ? (
              <DrawioEditor file={activeFile} />
            ) : isMarkdownPath(activeFile.path) ? (
              <MarkdownView file={activeFile} />
            ) : (
              <div className="h-full flex flex-col min-h-0">
                {activeFile.externallyChanged && (
                  <ExternalChangeBanner projectId={activeFile.projectId} path={activeFile.path} />
                )}
                <div className="flex-1 min-h-0 relative">
                  <MonacoMount file={activeFile} isActivePane={isActivePane} onFocusPane={onFocusPane} />
                  {/* Consent CTA: language has a tier-1 LSP server not yet installed. */}
                  <LspInstallPrompt projectId={activeFile.projectId} filePath={activeFile.path} />
                </div>
              </div>
            )}
          </Suspense>
        ) : isSplit ? (
          <EmptySplitPane />
        ) : (
          <WelcomeScreen />
        )}
      </div>
    </div>
  );
}

/** Placeholder for a freshly-split pane that has no tab yet. */
function EmptySplitPane() {
  return (
    <div className="h-full grid place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2 text-muted-foreground">
        <MousePointerSquareDashed className="h-6 w-6 opacity-60" />
        <p className="text-[12px] max-w-[16rem] leading-relaxed">
          Open a file or drag a tab here to use this split.
        </p>
      </div>
    </div>
  );
}

/**
 * Welcome card shown when no file is open — sells the "you're in an IDE"
 * feeling without demanding the user remember every shortcut up front.
 */
function WelcomeScreen() {
  const terminalOpen = useWorkspaceLayout((s) => s.activeBottom === 'terminal');

  // Drive the cards straight through the keymap command registry — the same
  // path the dispatcher and Search Everywhere use.
  const preset = useKeymapStore((s) => s.preset);
  const overrides = useKeymapStore((s) => s.overrides);
  void preset;
  void overrides;
  const [, bumpOnRegistry] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onCommandsChanged(bumpOnRegistry), []);

  const labelFor = (id: string): string => {
    const cmd = getCommand(id);
    return cmd ? bindingLabel(cmd) : '';
  };

  return (
    <div className="h-full grid place-items-center px-8 py-10">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 rounded-xl bg-primary/10 grid place-items-center">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-[16px] font-semibold text-foreground tracking-tight">
              Workspace ready
            </h1>
            <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
              Open a file from the Explorer, jump straight to one with Quick Open,
              or describe what you want to the agent on the right.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-left">
          <ActionCard
            icon={Search}
            label="Quick Open"
            shortcut={labelFor('navigate.file')}
            onClick={() => executeCommand('navigate.file')}
          />
          <ActionCard
            icon={FileCode2}
            label="Project files"
            shortcut={labelFor('view.toggleProjectTree')}
            onClick={() => executeCommand('view.toggleProjectTree')}
          />
          <ActionCard
            icon={MessageSquare}
            label="Agent chat"
            shortcut={labelFor('view.toggleChat')}
            onClick={() => executeCommand('view.toggleChat')}
          />
          <ActionCard
            icon={TerminalSquare}
            label="Terminal"
            shortcut={labelFor('view.toggleTerminal')}
            onClick={() => executeCommand('view.toggleTerminal')}
            active={terminalOpen}
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[10.5px] text-muted-foreground/80">
          <KeyHint label="Save" binding={labelFor('file.save')} />
          <KeyHint label="Save all" binding={labelFor('file.saveAll')} />
          <KeyHint label="Close tab" binding={labelFor('file.closeTab')} />
          <KeyHint label="Find Action" binding={labelFor('navigate.commands')} />
          <KeyHint label="Search Everywhere" binding={labelFor('navigate.searchEverywhere')} />
        </div>

        <div className="text-[10px] text-muted-foreground/60 inline-flex items-center gap-1.5">
          <FilePlus2 className="h-3 w-3" />
          Right-click anywhere in the file tree to create / rename / delete.
        </div>
      </div>
    </div>
  );
}

interface ActionCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
  active?: boolean;
  onClick: () => void;
}

function ActionCard({ icon: Icon, label, shortcut, active, onClick }: ActionCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group h-16 rounded-md border bg-card/40 px-3 text-left transition-colors hover:border-primary/40 hover:bg-card/80 flex flex-col justify-center gap-0.5 ${
        active ? 'border-primary/60 bg-primary/5' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-primary/80" />
        <span className="text-[12px] font-medium text-foreground">{label}</span>
      </div>
      <span className="text-[10px] text-muted-foreground/70 font-mono">{shortcut}</span>
    </button>
  );
}

function KeyHint({ label, binding }: { label: string; binding: string }) {
  // Unbound under the active preset → drop the hint rather than show a label
  // with no keys. Split chord sequences and combos into individual <kbd> tokens.
  if (!binding) return null;
  const keys = binding.split(' ').flatMap((chord) => chord.split('+'));
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span className="inline-flex items-center gap-0.5">
        {keys.map((k, i) => (
          <kbd
            key={`${k}-${i}`}
            className="px-1 py-px rounded-sm border bg-card text-[9.5px] font-mono"
          >
            {k}
          </kbd>
        ))}
      </span>
    </span>
  );
}

/**
 * Editor pane — Monaco mount + tab bar wired to the Zustand workspace
 * store. Monaco itself is lazy-loaded (Suspense fallback) so the
 * ~5 MB gzipped chunk only lands when the user actually opens a project.
 *
 * Empty state is a proper "Welcome to Workspace" surface: brand mark,
 * quick action chips (Quick Open, New File, Toggle Chat), and a hint
 * row showing the most useful shortcuts. Beats a one-line "no file
 * open" placeholder.
 */

import { Suspense, lazy } from 'react';
import {
  FileCode2,
  FilePlus2,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { EditorTabBar } from './EditorTabBar.js';

const MonacoMount = lazy(() =>
  import('./editor/MonacoMount.js').then((m) => ({ default: m.MonacoMount })),
);
const DiffMount = lazy(() =>
  import('./editor/DiffMount.js').then((m) => ({ default: m.DiffMount })),
);

export function EditorPane() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  return (
    <div className="h-full flex flex-col bg-background min-h-0">
      <EditorTabBar />
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
            {activeFile.kind === 'diff' ? (
              <DiffMount diff={activeFile} />
            ) : (
              <MonacoMount file={activeFile} />
            )}
          </Suspense>
        ) : (
          <WelcomeScreen />
        )}
      </div>
    </div>
  );
}

/**
 * Welcome card shown when no file is open — sells the "you're in an
 * IDE" feeling without demanding the user remember every shortcut up
 * front.
 */
function WelcomeScreen() {
  const layout = useWorkspaceLayout();

  const dispatch = (shortcut: string, mods: { shift?: boolean; alt?: boolean } = {}) => {
    // The Workspace's global keydown listener is what actually triggers
    // each action — sending a synthetic event keeps the action paths
    // in one place. If user-agents start filtering synthetic ctrl
    // combos we'll wire each card to a direct setState here.
    const event = new KeyboardEvent('keydown', {
      key: shortcut.toLowerCase(),
      ctrlKey: true,
      shiftKey: mods.shift ?? false,
      altKey: mods.alt ?? false,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
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
            shortcut="Ctrl+P"
            onClick={() => dispatch('p')}
          />
          <ActionCard
            icon={FileCode2}
            label="Project files"
            shortcut="Ctrl+B"
            onClick={() => dispatch('b')}
            active={layout.activeLeft === 'files'}
          />
          <ActionCard
            icon={MessageSquare}
            label="Agent chat"
            shortcut="Ctrl+Alt+B"
            onClick={() => layout.setActiveRight(layout.activeRight === 'chat' ? null : 'chat')}
            active={layout.activeRight === 'chat'}
          />
          <ActionCard
            icon={TerminalSquare}
            label="Terminal"
            shortcut="Ctrl+J"
            onClick={() => dispatch('j')}
            active={layout.activeBottom === 'terminal'}
          />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[10.5px] text-muted-foreground/80">
          <KeyHint label="Save" keys={['Ctrl', 'S']} />
          <KeyHint label="Save all" keys={['Ctrl', 'Shift', 'S']} />
          <KeyHint label="Close tab" keys={['Ctrl', 'W']} />
          <KeyHint label="Commands" keys={['Ctrl', 'Shift', 'P']} />
          <KeyHint label="Rename" keys={['F2']} />
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

function KeyHint({ label, keys }: { label: string; keys: string[] }) {
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

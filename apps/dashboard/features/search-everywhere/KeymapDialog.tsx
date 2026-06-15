/**
 * Keymap settings (Ctrl+Alt+S) — preset selector (IntelliJ default /
 * VS Code) + per-command rebinding with live key capture, conflict
 * highlighting and reset. Overrides persist via the keymap store.
 */
import { useEffect, useMemo, useState } from 'react';
import { Keyboard, RotateCcw, X } from 'lucide-react';
import { Dialog, DialogContent } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { listCommands, onCommandsChanged, type CommandDef } from '../../keymap/commands.js';
import { eventToChord } from '../../keymap/dispatcher.js';
import { bindingIndex, effectiveBinding, useKeymapStore, type KeymapPreset } from '../../keymap/keymap-store.js';
import { useSeStore } from './se-store.js';

export function KeymapDialog() {
  const open = useSeStore((s) => s.keymapOpen);
  const setOpen = useSeStore((s) => s.setKeymapOpen);
  const { preset, overrides, setPreset, setOverride, clearOverride, resetAll } = useKeymapStore();
  const [filter, setFilter] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [, bump] = useState(0);

  useEffect(() => onCommandsChanged(() => bump((n) => n + 1)), []);

  // Key capture: while a row is armed, the next chord becomes its binding
  // (a second chord within 1.2s composes a two-chord sequence).
  useEffect(() => {
    if (!capturing) return;
    let first: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const commit = (binding: string) => {
      setOverride(capturing, binding);
      setCapturing(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const chord = eventToChord(e);
      if (!chord) return;
      if (!first) {
        first = chord;
        timer = setTimeout(() => commit(first!), 1200);
      } else {
        if (timer) clearTimeout(timer);
        commit(`${first} ${chord}`);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (timer) clearTimeout(timer);
    };
  }, [capturing, setOverride]);

  const commands = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return listCommands()
      .filter((c) => !q || `${c.category} ${c.title}`.toLowerCase().includes(q))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }, [filter, preset, overrides, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflicts = useMemo(() => {
    const dupes = new Set<string>();
    for (const [, ids] of bindingIndex()) {
      if (ids.length > 1) for (const id of ids) dupes.add(id);
    }
    return dupes;
  }, [preset, overrides, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowBinding = (cmd: CommandDef): string | null => effectiveBinding(cmd, preset, overrides);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="p-0 gap-0 max-w-2xl top-[12%] translate-y-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Keyboard className="h-4 w-4 text-primary" />
          <span className="text-[13px] font-medium">Keymap</span>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value as KeymapPreset)}
            className="ml-2 h-6 rounded border bg-background text-[11.5px] px-1"
          >
            <option value="intellij">IntelliJ (default)</option>
            <option value="vscode">VS Code</option>
          </select>
          <span className="text-[10px] text-muted-foreground">editor-level remaps apply to new editors; reload recommended after switching</span>
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-[11px]" onClick={resetAll}>
            <RotateCcw className="h-3 w-3 mr-1" /> Reset all
          </Button>
        </div>
        <div className="p-2 border-b">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter actions…" className="h-7 text-[12px]" />
        </div>
        <div className="max-h-[440px] overflow-y-auto py-1">
          {commands.map((cmd) => {
            const binding = rowBinding(cmd);
            const overridden = cmd.id in overrides;
            const conflicted = binding ? conflicts.has(cmd.id) : false;
            return (
              <div key={cmd.id} className="px-3 py-1 flex items-center gap-2 text-[12px] hover:bg-muted/30">
                <span className="text-[10px] text-muted-foreground/70 w-20 shrink-0">{cmd.category}</span>
                <span className="truncate">{cmd.title}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {overridden && (
                    <button
                      type="button"
                      title="Reset to preset default"
                      onClick={() => clearOverride(cmd.id)}
                      className="text-muted-foreground/70 hover:text-foreground"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                  {binding && (
                    <button
                      type="button"
                      title="Remove binding"
                      onClick={() => setOverride(cmd.id, null)}
                      className="text-muted-foreground/70 hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setCapturing(cmd.id)}
                    className={cn(
                      'min-w-[110px] text-right font-mono text-[11px] px-1.5 py-0.5 rounded border',
                      capturing === cmd.id
                        ? 'border-primary text-primary animate-pulse'
                        : conflicted
                          ? 'border-red-500/60 text-red-400'
                          : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {capturing === cmd.id ? 'Press keys…' : binding ?? '—'}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

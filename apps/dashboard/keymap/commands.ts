/**
 * Command registry — the single source every surface binds to: the keymap
 * dispatcher, Search Everywhere's Commands tab and the keymap dialog.
 * Commands register at mount with closures over their surface's state and
 * unregister on cleanup (ProjectView owns most of them).
 */

export interface CommandDef {
  /** Stable id, e.g. 'file.save', 'navigate.searchEverywhere'. */
  id: string;
  /** Display title (English — UI chrome language of the IDE surfaces). */
  title: string;
  category: string;
  /**
   * Default bindings per preset. A binding is 1-2 chords separated by a
   * space, each chord like 'Ctrl+Shift+N' (token order Ctrl,Alt,Shift+Key
   * from e.code). The special binding 'Shift Shift' is the double-Shift.
   */
  defaultKeys?: { intellij?: string; vscode?: string };
  /** Extra gate evaluated at dispatch time (e.g. desktop-only keys). */
  when?: () => boolean;
  /** Allow firing while focus is in an input/textarea/contentEditable. */
  allowInInputs?: boolean;
  run: () => void | Promise<void>;
}

const commands = new Map<string, CommandDef>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* listener errors never break dispatch */ }
  }
}

/** Registry change subscription (keymap dialog / SE commands tab). */
export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerCommands(defs: CommandDef[]): () => void {
  for (const def of defs) commands.set(def.id, def);
  notify();
  return () => {
    for (const def of defs) {
      if (commands.get(def.id) === def) commands.delete(def.id);
    }
    notify();
  };
}

export function listCommands(): CommandDef[] {
  return [...commands.values()];
}

export function getCommand(id: string): CommandDef | undefined {
  return commands.get(id);
}

/** Run by id. False when unknown or gated off by `when`. */
export function executeCommand(id: string): boolean {
  const cmd = commands.get(id);
  if (!cmd) return false;
  if (cmd.when && !cmd.when()) return false;
  void cmd.run();
  return true;
}

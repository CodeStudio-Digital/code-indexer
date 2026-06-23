/**
 * Keymap state: preset (IntelliJ is the DEFAULT — the product's stated
 * north) + per-command overrides, persisted to localStorage. The effective
 * binding for a command is override ?? preset default.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { listCommands, type CommandDef } from './commands.js';

export type KeymapPreset = 'intellij' | 'vscode';

interface KeymapState {
  preset: KeymapPreset;
  /** commandId → binding string, or null = explicitly unbound. */
  overrides: Record<string, string | null>;
  setPreset: (preset: KeymapPreset) => void;
  setOverride: (commandId: string, binding: string | null) => void;
  clearOverride: (commandId: string) => void;
  resetAll: () => void;
}

export const useKeymapStore = create<KeymapState>()(
  persist(
    (set) => ({
      preset: 'intellij',
      overrides: {},
      setPreset: (preset) => set({ preset }),
      setOverride: (commandId, binding) =>
        set((s) => ({ overrides: { ...s.overrides, [commandId]: binding } })),
      clearOverride: (commandId) =>
        set((s) => {
          const next = { ...s.overrides };
          delete next[commandId];
          return { overrides: next };
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'mcp-ide:keymap' },
  ),
);

export function effectiveBinding(cmd: CommandDef, preset: KeymapPreset, overrides: Record<string, string | null>): string | null {
  if (cmd.id in overrides) return overrides[cmd.id];
  return cmd.defaultKeys?.[preset] ?? null;
}

/** chord-sequence string → command ids bound to it under current state. */
export function bindingIndex(): Map<string, string[]> {
  const { preset, overrides } = useKeymapStore.getState();
  const index = new Map<string, string[]>();
  for (const cmd of listCommands()) {
    const binding = effectiveBinding(cmd, preset, overrides);
    if (!binding) continue;
    const list = index.get(binding) ?? [];
    list.push(cmd.id);
    index.set(binding, list);
  }
  return index;
}

/** Pretty label for UI (— when unbound). */
export function bindingLabel(cmd: CommandDef): string {
  const { preset, overrides } = useKeymapStore.getState();
  return effectiveBinding(cmd, preset, overrides) ?? '';
}

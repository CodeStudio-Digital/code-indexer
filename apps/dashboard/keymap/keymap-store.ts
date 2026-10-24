import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { listCommands, type CommandSpec } from './commands.js';

export type KeymapPreset = 'intellij' | 'vscode';
type KeymapOverrides = Record<string, string[]>;

interface KeymapState {
  preset: KeymapPreset;
  /** commandId -> complete replacement list; [] means explicitly unbound. */
  overrides: KeymapOverrides;
  setPreset: (preset: KeymapPreset) => void;
  setBindings: (commandId: string, bindings: string[]) => void;
  addBinding: (commandId: string, binding: string) => void;
  removeBinding: (commandId: string, binding: string) => void;
  clearOverride: (commandId: string) => void;
  replaceConflict: (ownerId: string, binding: string, conflictingIds: string[]) => void;
  resetAll: () => void;
}

const unique = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];

export function migrateKeymapState(persisted: unknown): { preset: KeymapPreset; overrides: KeymapOverrides } {
  const raw = (persisted ?? {}) as { preset?: KeymapPreset; overrides?: Record<string, string | null | string[]> };
  const overrides: KeymapOverrides = {};
  for (const [id, value] of Object.entries(raw.overrides ?? {})) {
    overrides[id] = Array.isArray(value) ? unique(value) : typeof value === 'string' ? [value] : [];
  }
  return { preset: raw.preset ?? 'intellij', overrides };
}

export const useKeymapStore = create<KeymapState>()(
  persist(
    (set) => ({
      preset: 'intellij',
      overrides: {},
      setPreset: (preset) => set({ preset }),
      setBindings: (commandId, bindings) => set((s) => ({ overrides: { ...s.overrides, [commandId]: unique(bindings) } })),
      addBinding: (commandId, binding) => set((s) => {
        const current = effectiveBindingsById(commandId, s.preset, s.overrides);
        return { overrides: { ...s.overrides, [commandId]: unique([...current, binding]) } };
      }),
      removeBinding: (commandId, binding) => set((s) => ({
        overrides: {
          ...s.overrides,
          [commandId]: effectiveBindingsById(commandId, s.preset, s.overrides).filter((item) => item !== binding),
        },
      })),
      clearOverride: (commandId) => set((s) => {
        const next = { ...s.overrides };
        delete next[commandId];
        return { overrides: next };
      }),
      replaceConflict: (ownerId, binding, conflictingIds) => set((s) => {
        const overrides = { ...s.overrides };
        overrides[ownerId] = unique([...effectiveBindingsById(ownerId, s.preset, s.overrides), binding]);
        for (const id of conflictingIds) {
          overrides[id] = effectiveBindingsById(id, s.preset, s.overrides).filter((item) => item !== binding);
        }
        return { overrides };
      }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: 'mcp-ide:keymap',
      version: 2,
      migrate: migrateKeymapState,
    },
  ),
);

export function effectiveBindings(cmd: CommandSpec, preset: KeymapPreset, overrides: KeymapOverrides): string[] {
  if (cmd.id in overrides) return overrides[cmd.id] ?? [];
  return cmd.defaultKeys?.[preset] ?? [];
}

function effectiveBindingsById(commandId: string, preset: KeymapPreset, overrides: KeymapOverrides): string[] {
  const command = listCommands().find((item) => item.id === commandId);
  return command ? effectiveBindings(command, preset, overrides) : (overrides[commandId] ?? []);
}

export function bindingIndex(): Map<string, string[]> {
  const { preset, overrides } = useKeymapStore.getState();
  const index = new Map<string, string[]>();
  for (const cmd of listCommands()) {
    for (const binding of effectiveBindings(cmd, preset, overrides)) {
      const ids = index.get(binding) ?? [];
      ids.push(cmd.id);
      index.set(binding, ids);
    }
  }
  return index;
}

export function conflictingCommands(binding: string, ownerId?: string): string[] {
  const commands = listCommands();
  const owner = ownerId ? commands.find((command) => command.id === ownerId) : undefined;
  return (bindingIndex().get(binding) ?? []).filter((id) => {
    if (id === ownerId) return false;
    const other = commands.find((command) => command.id === id);
    return !owner || !other || contextsOverlap(owner.context, other.context);
  });
}

/** Conservative overlap check; recognizes common explicit negations. */
export function contextsOverlap(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  const clauses = (value: string) => value.split('&&').map((item) => item.trim()).filter(Boolean);
  const a = clauses(left);
  const b = clauses(right);
  return !a.some((item) => b.includes(item.startsWith('!') ? item.slice(1) : `!${item}`));
}

export function bindingLabel(cmd: CommandSpec): string {
  const { preset, overrides } = useKeymapStore.getState();
  return effectiveBindings(cmd, preset, overrides).map((binding) => displayBinding(binding)).join(', ');
}

export function displayBinding(binding: string, platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  if (!/mac/i.test(platform)) return binding;
  return binding.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
}

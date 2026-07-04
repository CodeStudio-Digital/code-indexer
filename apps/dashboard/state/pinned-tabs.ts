/**
 * Pinned Tabs store — global (cross-project) list of pinned navigation
 * targets, persisted to localStorage. Follows the manual-persist Zustand
 * pattern of `state/editor-theme.ts` (no middleware): each action computes the
 * next array, persists, and returns it. Array order === display order.
 */
import { create } from 'zustand';
import type { Pin, PinKind } from './pinned-tabs-types.js';

interface PinnedTabsState {
  pins: Pin[];
}

interface PinnedTabsStore extends PinnedTabsState {
  /** Upsert by id (append if new, replace href/label if the id already exists). */
  pin: (p: Pin) => void;
  unpin: (id: string) => void;
  togglePin: (p: Pin) => void;
  isPinned: (id: string) => boolean;
  /** Move `fromId` to sit immediately before `beforeId` (null → end). */
  reorder: (fromId: string, beforeId: string | null) => void;
  clear: () => void;
}

const STORAGE_KEY = 'mcp-ide:pinned-tabs';
const KINDS: PinKind[] = ['project', 'session', 'rail'];

function isValidPin(v: unknown): v is Pin {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.label === 'string' &&
    typeof p.icon === 'string' &&
    typeof p.href === 'string' &&
    KINDS.includes(p.kind as PinKind)
  );
}

function loadPersisted(): Pin[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: Pin[] = [];
    for (const item of parsed) {
      if (isValidPin(item) && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function persist(pins: Pin[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    /* quota / disabled — non-fatal, in-memory copy still works */
  }
}

/** Insert `moving` before `beforeId` (null = append), removing any prior copy. */
function insertBefore(order: Pin[], fromId: string, beforeId: string | null): Pin[] {
  const moving = order.find((p) => p.id === fromId);
  if (!moving) return order;
  const base = order.filter((p) => p.id !== fromId);
  if (beforeId === null) return [...base, moving];
  const idx = base.findIndex((p) => p.id === beforeId);
  return idx < 0 ? [...base, moving] : [...base.slice(0, idx), moving, ...base.slice(idx)];
}

const sameOrder = (a: Pin[], b: Pin[]): boolean =>
  a.length === b.length && a.every((p, i) => p.id === b[i].id);

export const usePinnedTabs = create<PinnedTabsStore>((set, get) => ({
  pins: loadPersisted(),

  pin: (p) =>
    set((s) => {
      const pins = s.pins.some((x) => x.id === p.id)
        ? s.pins.map((x) => (x.id === p.id ? p : x))
        : [...s.pins, p];
      persist(pins);
      return { pins };
    }),

  unpin: (id) =>
    set((s) => {
      const pins = s.pins.filter((x) => x.id !== id);
      persist(pins);
      return { pins };
    }),

  togglePin: (p) =>
    set((s) => {
      const exists = s.pins.some((x) => x.id === p.id);
      const pins = exists ? s.pins.filter((x) => x.id !== p.id) : [...s.pins, p];
      persist(pins);
      return { pins };
    }),

  isPinned: (id) => get().pins.some((x) => x.id === id),

  reorder: (fromId, beforeId) =>
    set((s) => {
      const pins = insertBefore(s.pins, fromId, beforeId);
      if (sameOrder(pins, s.pins)) return s;
      persist(pins);
      return { pins };
    }),

  clear: () =>
    set(() => {
      persist([]);
      return { pins: [] };
    }),
}));

/** Plain snapshot for non-hook callers (context-menu builders). */
export function pinnedTabsSnapshot(): Pin[] {
  return usePinnedTabs.getState().pins;
}

export function hasPin(id: string): boolean {
  return usePinnedTabs.getState().pins.some((p) => p.id === id);
}

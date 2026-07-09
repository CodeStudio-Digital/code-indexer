/**
 * Column configuration for the SFTP file panes — which metadata columns (Size,
 * Modified, Permissions) appear alongside the always-on Name column. Shared by
 * both panes (local + remote) so the layout is symmetric. Persisted to
 * localStorage so the user's choice survives panel reloads.
 *
 * Column order is fixed (Name → Size → Modified → Permissions, matching
 * FileZilla/WinSCP). Toggling a column show/hides it; Name is non-toggleable.
 */
import { useCallback, useState } from 'react';

export type ColumnId = 'size' | 'modified' | 'permissions';

export interface ColumnDef {
  id: ColumnId;
  /** i18n key suffix under `sftp.columns` (e.g. 'size' → t('sftp.columns.size')). */
  labelKey: string;
  /** Initial pixel width — header and row cells share user-resized widths. */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

/** Fixed display order. `name` is always rendered and not in this list. */
export const COLUMNS: readonly ColumnDef[] = [
  { id: 'size', labelKey: 'size', defaultWidth: 80, minWidth: 56, maxWidth: 180 },
  { id: 'modified', labelKey: 'modified', defaultWidth: 144, minWidth: 92, maxWidth: 240 },
  { id: 'permissions', labelKey: 'permissions', defaultWidth: 112, minWidth: 84, maxWidth: 180 },
];

const STORAGE_KEY = 'mcp-sftp:columns';
const WIDTHS_STORAGE_KEY = 'mcp-sftp:column-widths';

export interface ColumnVisibility {
  size: boolean;
  modified: boolean;
  permissions: boolean;
}

export type ColumnWidths = Record<ColumnId, number>;

const DEFAULTS: ColumnVisibility = {
  size: true,
  modified: true,
  permissions: false,
};

const DEFAULT_WIDTHS: ColumnWidths = Object.fromEntries(COLUMNS.map((c) => [c.id, c.defaultWidth])) as ColumnWidths;

function load(): ColumnVisibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<ColumnVisibility>;
    return {
      size: parsed.size ?? DEFAULTS.size,
      modified: parsed.modified ?? DEFAULTS.modified,
      permissions: parsed.permissions ?? DEFAULTS.permissions,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(v: ColumnVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage blocked / unavailable — in-memory only */
  }
}

function clampWidth(id: ColumnId, width: number): number {
  const def = COLUMNS.find((c) => c.id === id);
  if (!def || !Number.isFinite(width)) return DEFAULT_WIDTHS[id];
  return Math.min(def.maxWidth, Math.max(def.minWidth, Math.round(width)));
}

function loadWidths(): ColumnWidths {
  try {
    const raw = localStorage.getItem(WIDTHS_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTHS;
    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      size: clampWidth('size', parsed.size ?? DEFAULT_WIDTHS.size),
      modified: clampWidth('modified', parsed.modified ?? DEFAULT_WIDTHS.modified),
      permissions: clampWidth('permissions', parsed.permissions ?? DEFAULT_WIDTHS.permissions),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

function saveWidths(v: ColumnWidths): void {
  try {
    localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage blocked / unavailable — in-memory only */
  }
}

/**
 * Column visibility state + toggle. Used by both FilePane and FilePaneRow so
 * the header and rows stay in sync. A change re-renders every row in the pane
 * (acceptable: listings are tens to low-hundreds of entries).
 */
export function useColumnConfig(): {
  visibility: ColumnVisibility;
  visibleColumns: readonly ColumnDef[];
  widths: ColumnWidths;
  toggle: (id: ColumnId) => void;
  setWidth: (id: ColumnId, width: number) => void;
} {
  const [visibility, setVisibility] = useState<ColumnVisibility>(load);
  const [widths, setWidths] = useState<ColumnWidths>(loadWidths);

  const toggle = useCallback((id: ColumnId) => {
    setVisibility((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      save(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((id: ColumnId, width: number) => {
    setWidths((prev) => {
      const next = { ...prev, [id]: clampWidth(id, width) };
      saveWidths(next);
      return next;
    });
  }, []);

  const visibleColumns = COLUMNS.filter((c) => visibility[c.id]);

  return { visibility, visibleColumns, widths, toggle, setWidth };
}

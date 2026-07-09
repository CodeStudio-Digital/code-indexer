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
  /** Fixed pixel width — header and row cells share this so they align. */
  width: string;
}

/** Fixed display order. `name` is always rendered and not in this list. */
export const COLUMNS: readonly ColumnDef[] = [
  { id: 'size', labelKey: 'size', width: 'w-16' },
  { id: 'modified', labelKey: 'modified', width: 'w-28' },
  { id: 'permissions', labelKey: 'permissions', width: 'w-24' },
];

const STORAGE_KEY = 'mcp-sftp:columns';

export interface ColumnVisibility {
  size: boolean;
  modified: boolean;
  permissions: boolean;
}

const DEFAULTS: ColumnVisibility = {
  size: true,
  modified: true,
  permissions: false,
};

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

/**
 * Column visibility state + toggle. Used by both FilePane and FilePaneRow so
 * the header and rows stay in sync. A change re-renders every row in the pane
 * (acceptable: listings are tens to low-hundreds of entries).
 */
export function useColumnConfig(): {
  visibility: ColumnVisibility;
  visibleColumns: readonly ColumnDef[];
  toggle: (id: ColumnId) => void;
} {
  const [visibility, setVisibility] = useState<ColumnVisibility>(load);

  const toggle = useCallback((id: ColumnId) => {
    setVisibility((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      save(next);
      return next;
    });
  }, []);

  const visibleColumns = COLUMNS.filter((c) => visibility[c.id]);

  return { visibility, visibleColumns, toggle };
}

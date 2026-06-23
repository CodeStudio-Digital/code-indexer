import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';

/**
 * Reserved header names that must never be set via the admin UI:
 * — Authorization is managed by the auth_type mechanism
 * — Cookie and Mcp-Session-Id are transport-controlled
 */
const RESERVED = new Set(['authorization', 'cookie', 'mcp-session-id']);

export function isReservedHeader(name: string): boolean {
  return RESERVED.has(name.trim().toLowerCase());
}

interface HeaderRowsEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}

type Row = { k: string; v: string };

/**
 * Key/value editor for custom HTTP headers.
 *
 * Owns a local `rows` array so users can keep half-typed rows (including
 * blank-key ones just added via "+ Add") without them being filtered out
 * of the emitted object. `onChange` receives only completed rows — blanks
 * are dropped at emit time but preserved in local state.
 */
export function HeaderRowsEditor({ value, onChange, disabled }: HeaderRowsEditorProps) {
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value).map(([k, v]) => ({ k, v })),
  );

  // Sync local rows when the parent replaces `value` wholesale (e.g., when
  // switching to a different server). We ignore echo updates from our own
  // emit by comparing against the last value we produced.
  const lastEmitted = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (lastEmitted.current && shallowEqual(value, lastEmitted.current)) return;
    setRows(Object.entries(value).map(([k, v]) => ({ k, v })));
  }, [value]);

  const emit = (next: Row[]): void => {
    const out: Record<string, string> = {};
    for (const { k, v } of next) {
      const key = k.trim();
      if (key) out[key] = v;
    }
    lastEmitted.current = out;
    onChange(out);
  };

  const update = (i: number, patch: Partial<Row>): void => {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    setRows(next);
    emit(next);
  };

  const remove = (i: number): void => {
    const next = rows.filter((_, j) => j !== i);
    setRows(next);
    emit(next);
  };

  const add = (): void => {
    // Keep blank rows in local state. emit() skips them — the parent
    // only sees completed pairs.
    setRows((prev) => [...prev, { k: '', v: '' }]);
  };

  return (
    <div className="space-y-1.5">
      {rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No custom headers. Add one to send an extra HTTP header with every request.
        </p>
      )}
      {rows.map((row, i) => {
        const reserved = !!row.k && isReservedHeader(row.k);
        return (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              <Input
                value={row.k}
                onChange={(e) => update(i, { k: e.target.value })}
                placeholder="Header-Name"
                disabled={disabled}
                className={reserved ? 'border-destructive' : undefined}
              />
              {reserved && (
                <p className="text-[10px] text-destructive mt-0.5">
                  &lsquo;{row.k}&rsquo; is reserved and will be rejected on save.
                </p>
              )}
            </div>
            <Input
              value={row.v}
              onChange={(e) => update(i, { v: e.target.value })}
              placeholder="value"
              disabled={disabled}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              disabled={disabled}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
        <Plus className="h-3 w-3 mr-1" /> Add header
      </Button>
    </div>
  );
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

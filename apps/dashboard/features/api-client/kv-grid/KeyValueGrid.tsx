/**
 * Reusable key/value grid (Postman-style table) over KvRow[]. Columns: enabled ·
 * key · value · description · remove, as an aligned bordered table with borderless
 * cell inputs. A trailing blank row materializes on edit. "Bulk Edit" swaps the
 * table for a `Key: Value` textarea.
 *
 * Controlled: `rows` in, `onChange` out (live, for the draft). `onCommit(rows)`
 * persists the GIVEN rows — fired on input blur and immediately on structural
 * edits (remove, enable toggle). Structural edits pass the new array explicitly
 * so persistence never reads a stale post-setState draft.
 *
 * Sizes to its content (not full height) so short lists don't stretch to a giant
 * empty table; the parent scrolls when there are many rows.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, List, Table2 } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { cn } from '../../../lib/utils.js';
import type { KvRow } from '../types.js';
import { rowsToBulk, bulkToRows } from './bulk-edit.js';

interface Props {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  onCommit?: (rows: KvRow[]) => void;
  placeholderKey?: string;
  descriptions?: boolean;
  suggestions?: string[];
  fileRows?: boolean;
  disabled?: boolean;
}

const CELL = 'h-8 border-0 rounded-none bg-transparent px-2 text-xs font-mono shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:bg-muted/40';

export function KeyValueGrid({ rows, onChange, onCommit, placeholderKey = 'key', descriptions = true, suggestions, fileRows, disabled }: Props) {
  const { t } = useTranslation('apiClient');
  const [bulk, setBulk] = useState(false);
  const listId = useId();
  const cols = descriptions ? '2rem minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) 2rem' : '2rem minmax(0,1fr) minmax(0,1fr) 2rem';

  // Live (draft) edit — persisted on blur.
  const setRow = (i: number, p: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const addRow = (p: Partial<KvRow>) => onChange([...rows, { key: '', value: '', enabled: true, ...p }]);
  // Structural edit — persist the new array immediately (no stale draft read).
  const commitRows = (next: KvRow[]) => { onChange(next); onCommit?.(next); };
  const toggleRow = (i: number, enabled: boolean) => commitRows(rows.map((r, j) => (j === i ? { ...r, enabled } : r)));
  const removeRow = (i: number) => commitRows(rows.filter((_, j) => j !== i));

  if (bulk) {
    return (
      <div className="flex flex-col gap-2">
        <Toolbar bulk onToggle={() => setBulk(false)} />
        <Textarea
          defaultValue={rowsToBulk(rows)}
          onChange={(e) => onChange(bulkToRows(e.target.value))}
          onBlur={() => onCommit?.(rows)}
          placeholder={'Key: Value\n# Disabled: row'}
          className="h-48 font-mono text-xs resize-y"
          disabled={disabled}
        />
      </div>
    );
  }

  const render = [...rows, { key: '', value: '', enabled: true } as KvRow];
  return (
    <div className="flex flex-col gap-1.5">
      <Toolbar bulk={false} onToggle={() => setBulk(true)} />
      {suggestions && <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>}
      <div className="border rounded-md overflow-hidden">
        <div className="grid items-center text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/40 border-b" style={{ gridTemplateColumns: cols }}>
          <span />
          <span className="px-2 py-1">{descriptions ? t('grid.colKey') : placeholderKey}</span>
          <span className="px-2 py-1 border-l border-border/40">{t('grid.colValue')}</span>
          {descriptions && <span className="px-2 py-1 border-l border-border/40">{t('grid.colDescription')}</span>}
          <span />
        </div>
        {render.map((row, i) => {
          const isBlank = i === rows.length;
          return (
            <div
              key={i}
              className={cn('group grid items-center border-b border-border/30 last:border-b-0', !isBlank && !row.enabled && 'opacity-45')}
              style={{ gridTemplateColumns: cols }}
            >
              <div className="flex justify-center">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={isBlank ? true : row.enabled}
                  disabled={disabled || isBlank}
                  onChange={(e) => toggleRow(i, e.target.checked)}
                  title={t('grid.enabled')}
                  tabIndex={isBlank ? -1 : 0}
                />
              </div>
              <Input
                value={row.key}
                list={suggestions ? listId : undefined}
                placeholder={isBlank ? t('grid.addPlaceholder', { field: placeholderKey }) : placeholderKey}
                disabled={disabled}
                onChange={(e) => (isBlank ? addRow({ key: e.target.value }) : setRow(i, { key: e.target.value }))}
                onBlur={() => onCommit?.(rows)}
                className={cn(CELL, 'border-l border-border/40')}
              />
              <div className="flex items-center border-l border-border/40">
                {fileRows && !isBlank && (
                  <select
                    className="h-8 text-[10px] bg-transparent border-0 pl-1 pr-0.5 text-muted-foreground focus:outline-none"
                    value={row.src != null ? 'file' : 'text'}
                    onChange={(e) => commitRows(rows.map((r, j) => (j === i ? { ...r, src: e.target.value === 'file' ? '' : undefined, value: e.target.value === 'file' ? '' : r.value } : r)))}
                  >
                    <option value="text">{t('grid.srcText')}</option>
                    <option value="file">{t('grid.srcFile')}</option>
                  </select>
                )}
                <Input
                  value={row.src != null ? row.src : row.value}
                  placeholder={row.src != null ? '/path/to/file' : t('grid.valuePlaceholder')}
                  disabled={disabled}
                  onChange={(e) => (isBlank
                    ? addRow({ value: e.target.value })
                    : setRow(i, row.src != null ? { src: e.target.value } : { value: e.target.value }))}
                  onBlur={() => onCommit?.(rows)}
                  className={cn(CELL, 'flex-1')}
                />
              </div>
              {descriptions && (
                <Input
                  value={row.description ?? ''}
                  placeholder={t('grid.descriptionPlaceholder')}
                  disabled={disabled}
                  onChange={(e) => (isBlank ? addRow({ description: e.target.value }) : setRow(i, { description: e.target.value }))}
                  onBlur={() => onCommit?.(rows)}
                  className={cn(CELL, 'border-l border-border/40 text-muted-foreground')}
                />
              )}
              <div className="flex justify-center border-l border-border/40">
                <button
                  type="button"
                  aria-label={t('grid.removeRow')}
                  className={cn('h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100', isBlank && 'invisible pointer-events-none')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeRow(i)}
                  disabled={disabled}
                  tabIndex={-1}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Toolbar({ bulk, onToggle }: { bulk: boolean; onToggle: () => void }) {
  const { t } = useTranslation('apiClient');
  return (
    <div className="flex justify-end">
      <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 text-[11px] text-muted-foreground" onClick={onToggle}>
        {bulk ? <><Table2 className="h-3 w-3" /> {t('grid.grid')}</> : <><List className="h-3 w-3" /> {t('grid.bulkEdit')}</>}
      </Button>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Braces, CalendarDays, Check, Hash, ToggleLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { cn } from '../../../lib/utils.js';
import type { DbColumn } from '../types.js';
import { coerceColumnValue, editorSpecForColumn, formatColumnValue } from './column-editor.js';

export function RowEditorDialog({
  open,
  columns,
  row,
  isNew,
  onSave,
  onClose,
}: {
  open: boolean;
  columns: DbColumn[];
  row: Record<string, unknown>;
  isNew: boolean;
  onSave: (values: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('dbClient');
  const specs = useMemo(() => Object.fromEntries(columns.map((column) => [column.name, editorSpecForColumn(column)])), [columns]);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(
    columns.map((column) => [column.name, formatColumnValue(row[column.name], specs[column.name])]),
  ));
  const [nulls, setNulls] = useState<Set<string>>(() => new Set(
    columns.filter((column) => row[column.name] === null).map((column) => column.name),
  ));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    try {
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        // Only return fields changed in the modal. Besides producing smaller
        // UPDATEs, this preserves driver-native values such as DECIMAL strings
        // when the user only edits a different column.
        if (!touched.has(column.name)) continue;
        if (nulls.has(column.name)) {
          values[column.name] = null;
          continue;
        }
        const draft = drafts[column.name] ?? '';
        // Blank new fields stay absent so the database can apply defaults and
        // auto-increment values. Explicit NULL remains available above.
        if (isNew && row[column.name] === undefined && draft === '') continue;
        values[column.name] = coerceColumnValue(draft, specs[column.name]);
      }
      onSave(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm">{isNew ? t('edit.newRowTitle') : t('edit.rowTitle')}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[68vh] space-y-2 overflow-y-auto p-4">
          {columns.map((column) => {
            const spec = specs[column.name];
            const isNull = nulls.has(column.name);
            return (
              <div key={column.name} className="grid grid-cols-[minmax(140px,0.34fr)_minmax(0,1fr)] items-start gap-3">
                <div className="min-w-0 pt-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <TypeIcon kind={spec.kind} />
                    <span className="truncate" title={column.name}>{column.name}</span>
                    {column.isPrimaryKey && <span className="text-[9px] text-amber-400">PK</span>}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground" title={column.dataType}>{column.dataType}</div>
                </div>
                <div className="flex min-w-0 items-start gap-2">
                  <div className={cn('min-w-0 flex-1', isNull && 'opacity-40')}>
                    <ColumnControl
                      kind={spec.kind}
                      enumValues={spec.enumValues}
                      value={drafts[column.name] ?? ''}
                      disabled={isNull}
                      onChange={(value) => {
                        setTouched((current) => new Set(current).add(column.name));
                        setDrafts((current) => ({ ...current, [column.name]: value }));
                      }}
                    />
                  </div>
                  {column.nullable && (
                    <label className="flex h-7 shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={isNull}
                        onChange={(event) => setNulls((current) => {
                          setTouched((touchedColumns) => new Set(touchedColumns).add(column.name));
                          const next = new Set(current);
                          if (event.target.checked) next.add(column.name);
                          else next.delete(column.name);
                          return next;
                        })}
                      />
                      NULL
                    </label>
                  )}
                </div>
              </div>
            );
          })}
          {error && <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-400">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('edit.cancel')}</Button>
          <Button size="sm" onClick={submit}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            {t('edit.saveRow')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ColumnControl({
  kind,
  enumValues,
  value,
  disabled,
  onChange,
}: {
  kind: ReturnType<typeof editorSpecForColumn>['kind'];
  enumValues: string[];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const common = 'h-7 w-full rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 font-mono text-xs outline-none focus:border-[var(--workbench-focus)]';
  if (kind === 'json') {
    return <textarea className={`${common} h-28 resize-y py-1.5`} value={value} disabled={disabled} spellCheck={false} onChange={(e) => onChange(e.target.value)} />;
  }
  if (kind === 'enum') {
    return (
      <select className={common} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="" />
        {enumValues.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (kind === 'boolean') {
    return (
      <select className={common} value={value === '1' ? 'true' : value === '0' ? 'false' : value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  const inputType = kind === 'number' ? 'number' : kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime-local' : kind === 'time' ? 'time' : 'text';
  return <input type={inputType} className={common} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}

function TypeIcon({ kind }: { kind: ReturnType<typeof editorSpecForColumn>['kind'] }) {
  if (kind === 'json') return <Braces className="h-3 w-3 text-cyan-400" />;
  if (kind === 'date' || kind === 'datetime' || kind === 'time') return <CalendarDays className="h-3 w-3 text-amber-400" />;
  if (kind === 'number') return <Hash className="h-3 w-3 text-sky-400" />;
  if (kind === 'boolean' || kind === 'enum') return <ToggleLeft className="h-3 w-3 text-violet-400" />;
  return null;
}

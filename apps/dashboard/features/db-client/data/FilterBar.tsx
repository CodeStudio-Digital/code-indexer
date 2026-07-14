/**
 * Visual filter bar — the default mode of the table-data tab. Pick which columns
 * show, add WHERE conditions (column · operator · value, AND-combined) and apply;
 * results stay paginated + editable. A button flips to the raw SQL editor.
 */
import { useTranslation } from 'react-i18next';
import { Plus, X, Play, Code2, Columns3, Check } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../../components/ui/dropdown-menu.js';
import type { DbWhereCondition, DbWhereOp } from '../types.js';

const OPS: Array<{ value: DbWhereOp; label: string }> = [
  { value: '=', label: '=' }, { value: '!=', label: '≠' }, { value: '<', label: '<' }, { value: '<=', label: '≤' },
  { value: '>', label: '>' }, { value: '>=', label: '≥' }, { value: 'like', label: 'LIKE' },
  { value: 'isnull', label: 'IS NULL' }, { value: 'isnotnull', label: 'IS NOT NULL' },
];

const needsValue = (op: DbWhereOp): boolean => op !== 'isnull' && op !== 'isnotnull';

export function FilterBar({
  columns,
  conditions,
  onChange,
  hidden,
  onToggleColumn,
  onApply,
  onOpenSql,
  loading,
}: {
  columns: string[];
  conditions: DbWhereCondition[];
  onChange: (c: DbWhereCondition[]) => void;
  hidden: Set<string>;
  onToggleColumn: (col: string) => void;
  onApply: () => void;
  onOpenSql: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation('dbClient');
  const setCond = (i: number, patch: Partial<DbWhereCondition>): void => onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCond = (): void => onChange([...conditions, { column: columns[0] ?? '', op: '=', value: '' }]);
  const removeCond = (i: number): void => onChange(conditions.filter((_, idx) => idx !== i));

  return (
    <div className="flex flex-col gap-1 border-b p-1.5">
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Columns3 className="mr-1.5 h-3 w-3" />
              {t('filter.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-auto text-xs">
            {columns.map((c) => (
              <DropdownMenuItem key={c} onSelect={(e) => { e.preventDefault(); onToggleColumn(c); }}>
                <Check className={`mr-2 h-3.5 w-3.5 ${hidden.has(c) ? 'opacity-0' : ''}`} />
                {c}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" onClick={addCond}>
          <Plus className="mr-1.5 h-3 w-3" />
          {t('filter.addCondition')}
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={onApply} disabled={loading}>
          <Play className="mr-1.5 h-3 w-3" />
          {t('filter.apply')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpenSql} title={t('filter.sqlMode')}>
          <Code2 className="mr-1.5 h-3 w-3" />
          {t('filter.sql')}
        </Button>
      </div>

      {conditions.map((c, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            className="h-7 max-w-[40%] rounded border bg-background px-1.5 text-xs"
            value={c.column}
            onChange={(e) => setCond(i, { column: e.target.value })}
          >
            {columns.map((col) => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>
          <select
            className="h-7 rounded border bg-background px-1 text-xs"
            value={c.op}
            onChange={(e) => setCond(i, { op: e.target.value as DbWhereOp })}
          >
            {OPS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {needsValue(c.op) && (
            <input
              className="h-7 flex-1 rounded border bg-background px-2 font-mono text-xs outline-none"
              value={c.value ?? ''}
              placeholder={t('filter.value')}
              onChange={(e) => setCond(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && onApply()}
            />
          )}
          <button className="rounded p-1 text-muted-foreground hover:text-red-400" title={t('filter.remove')} onClick={() => removeCond(i)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

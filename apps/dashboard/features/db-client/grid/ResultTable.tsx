/**
 * Shared read-only results grid (a capped HTML table) rendered from a
 * `DbQueryResult`. Used by both the query console and the table-data tab. The
 * virtualized + editable grid arrives in P2 — this is the plain, correct base.
 */
import { useTranslation } from 'react-i18next';
import type { DbQueryResult } from '../types.js';

export function ResultTable({ result, error }: { result: DbQueryResult | null; error?: string | null }) {
  const { t } = useTranslation('dbClient');

  if (error) {
    return <div className="m-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>;
  }
  if (!result) return null;

  const columns = columnNames(result);
  if (columns.length === 0 || result.rows.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        {result.command ? `${result.command} · ${result.rowCount} ${t('query.affected')}` : t('query.empty')}
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-xs">
      <thead className="sticky top-0 bg-card">
        <tr>
          <th className="w-10 border-b border-r px-2 py-1 text-right font-normal text-muted-foreground/60">#</th>
          {columns.map((c) => (
            <th key={c} className="border-b border-r px-2 py-1 text-left font-medium text-muted-foreground">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i} className="hover:bg-muted/40">
            <td className="border-b border-r px-2 py-1 text-right text-muted-foreground/50 tabular-nums">{i + 1}</td>
            {columns.map((c) => (
              <td key={c} className="max-w-[320px] truncate border-b border-r px-2 py-1 font-mono" title={cellText(row[c])}>
                {cellText(row[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function columnNames(result: DbQueryResult): string[] {
  if (result.fields.length > 0) return result.fields.map((f) => f.name);
  return result.rows[0] ? Object.keys(result.rows[0]) : [];
}

export function cellText(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

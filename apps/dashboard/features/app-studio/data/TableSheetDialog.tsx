/**
 * "Ver como planilha" — modal read-only com até 100 linhas de uma tabela.
 * Tabela HTML simples com zebra (SEM VirtualResultGrid do db-client:
 * orientado a SQL/edição, peso desnecessário aqui).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { fetchTableSheet } from './useAppData.js';

export function TableSheetDialog({
  sessionId,
  table,
  label,
  onClose,
}: {
  sessionId: string;
  table: string;
  label: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchTableSheet(sessionId, table)
      .then((sheet) => {
        if (cancelled) return;
        setColumns(sheet.columns);
        setRows(sheet.rows);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, table]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border bg-card shadow-lg" onClick={(e) => e.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">{label}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> …
            </p>
          )}
          {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}
          {!loading && !error && (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b text-left">
                  {columns.map((col) => (
                    <th key={col} className="px-2 py-1.5 font-semibold">{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/50 odd:bg-muted/20">
                    {columns.map((col) => (
                      <td key={col} className="max-w-48 truncate px-2 py-1">{row[col] == null ? '—' : String(row[col])}</td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(columns.length, 1)} className="px-2 py-3 text-center text-muted-foreground">
                      {t('data.empty')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SendResponse } from '../types.js';
import { compareBodies, type ComparisonResponse } from './compare-responses.js';
import { formatBytes } from './format-body.js';

export function ResponseComparison({ previous, current }: { previous: ComparisonResponse | null; current: SendResponse | null }) {
  const { t } = useTranslation('apiClient');
  const diff = useMemo(() => previous && current && compareBodies(previous, current), [previous, current]);
  if (!previous || !current || !diff) return (
    <div className="grid h-full place-items-center p-4 text-center text-xs text-muted-foreground">{t('compare.empty')}</div>
  );
  const size = (r: ComparisonResponse) => formatBytes(r.size ?? new TextEncoder().encode(r.body ?? '').length);
  return (
    <div className="h-full overflow-auto p-2 text-xs">
      <table className="w-full table-fixed border-collapse text-left">
        <thead className="text-muted-foreground"><tr>
          <th scope="col" className="pb-2">{t('compare.field')}</th><th scope="col">{t('compare.before')}</th><th scope="col">{t('compare.after')}</th>
        </tr></thead>
        <tbody className="font-mono">
          {[
            { path: 'HTTP', before: previous.status, after: current.status },
            { path: t('compare.duration'), before: previous.ms + ' ms', after: current.ms + ' ms' },
            { path: t('compare.size'), before: size(previous), after: size(current) },
            ...diff.changes,
          ].map((row, i) => <tr key={i} className="border-t align-top">
            <th scope="row" className="break-all py-1 pr-1 font-normal">{row.path}</th>
            <td className="whitespace-pre-wrap break-all p-1">{row.before ?? '—'}</td>
            <td className="whitespace-pre-wrap break-all p-1">{row.after ?? '—'}</td>
          </tr>)}
        </tbody>
      </table>
      {diff.limited ? <p className="mt-3 text-muted-foreground">{t('compare.limited')}</p>
        : !diff.changes.length && <p className="mt-3 text-muted-foreground">{t('compare.same')}</p>}
    </div>
  );
}

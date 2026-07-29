/**
 * Evaluate a JSONPath expression over the response body (quick win — the
 * WebStorm/REST-client "evaluate JSONPath" affordance). Reuses JsonTree to
 * render the matches; degrades gracefully when the body isn't JSON or the
 * expression is invalid.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JSONPath } from 'jsonpath-plus';
import { JsonTree } from './JsonTree.js';

export function JsonPathPanel({ body }: { body: string }) {
  const { t } = useTranslation('apiClient');
  const [path, setPath] = useState('$');

  const parsed = useMemo<{ ok: true; value: unknown } | { ok: false }>(() => {
    try { return { ok: true, value: JSON.parse(body) }; } catch { return { ok: false }; }
  }, [body]);

  const result = useMemo<{ matches: unknown[] } | { error: string }>(() => {
    if (!parsed.ok) return { error: t('jsonPath.notJson', { defaultValue: 'Response body is not JSON.' }) };
    if (!path.trim()) return { matches: [] };
    try {
      return { matches: JSONPath({ path, json: parsed.value as object, wrap: true }) as unknown[] };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [parsed, path, t]);

  const matches = 'matches' in result ? result.matches : null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <span className="text-[11px] font-mono text-muted-foreground shrink-0">{t('jsonPath.label')}</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          placeholder={t('jsonPath.placeholder')}
          aria-label={t('jsonPath.expressionAria')}
          className="flex-1 h-6 rounded border bg-card px-2 text-[12px] font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        {matches && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {t('jsonPath.matchCount', { count: matches.length, defaultValue: '{{count}} matches' })}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {'error' in result ? (
          <div className="text-xs text-amber-500 font-mono whitespace-pre-wrap">{result.error}</div>
        ) : matches && matches.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('jsonPath.noMatches', { defaultValue: 'No matches.' })}</div>
        ) : (
          <JsonTree body={JSON.stringify(matches)} />
        )}
      </div>
    </div>
  );
}

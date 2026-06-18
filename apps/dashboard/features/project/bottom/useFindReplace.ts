/**
 * State + API for the Find/Replace-in-files panel. Debounces the grep on
 * query/option changes, exposes the toggles, and runs replace-all (then
 * re-greps so the results reflect the new file contents).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../../../lib/api-client.js';
import type { FindOpts, GResult, Selected } from './find-types.js';

const MAX_MATCHES = 2000;

export type FindCtl = ReturnType<typeof useFindReplace>;

export function useFindReplace(projectId: number) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [opts, setOpts] = useState<FindOpts>({ caseSensitive: false, wholeWord: false, regex: false, mask: '' });
  const [result, setResult] = useState<GResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceMsg, setReplaceMsg] = useState<string | null>(null);
  // Two-step confirm: Replace All writes files, so the first click arms and the
  // second executes. Any change to the search/replace/results disarms it.
  const [armed, setArmed] = useState(false);

  const run = useCallback(
    async (q: string, o: FindOpts) => {
      if (!q) { setResult(null); setError(null); return; }
      setLoading(true);
      setError(null);
      try {
        const r = await apiCall<GResult>('search.grep', {
          projectId, query: q,
          regex: o.regex, caseSensitive: o.caseSensitive, wholeWord: o.wholeWord,
          mask: o.mask, maxMatches: MAX_MATCHES,
        });
        setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResult(null);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  // Debounce 300ms on query/options.
  useEffect(() => {
    const t = setTimeout(() => void run(query, opts), 300);
    return () => clearTimeout(t);
  }, [query, opts, run]);

  const toggle = useCallback((k: 'caseSensitive' | 'wholeWord' | 'regex') => {
    setOpts((o) => ({ ...o, [k]: !o[k] }));
  }, []);
  const setMask = useCallback((mask: string) => setOpts((o) => ({ ...o, mask })), []);

  // Disarm the confirm whenever the inputs or the result set change.
  useEffect(() => { setArmed(false); }, [query, replacement, opts, result]);

  const replaceAll = useCallback(async () => {
    if (!query || !result || result.fileCount === 0) return;
    if (!armed) { setArmed(true); return; } // first click arms the confirm
    setArmed(false);
    setReplacing(true);
    setReplaceMsg(null);
    try {
      const r = await apiCall<{ replaced: number; fileCount: number }>('search.replace', {
        projectId, query, replacement,
        regex: opts.regex, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord, mask: opts.mask,
      });
      setReplaceMsg(`Replaced ${r.replaced} in ${r.fileCount} file${r.fileCount === 1 ? '' : 's'}`);
      await run(query, opts); // refresh against the new contents
    } catch (e) {
      setReplaceMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setReplacing(false);
    }
  }, [projectId, query, replacement, opts, result, armed, run]);

  return {
    query, setQuery, replacement, setReplacement,
    opts, toggle, setMask,
    result, loading, error,
    selected, setSelected,
    replacing, replaceMsg, replaceAll, armed,
  };
}

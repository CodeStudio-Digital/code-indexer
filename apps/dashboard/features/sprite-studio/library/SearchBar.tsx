/**
 * Library search input — controlled text filter over asset names/tags.
 * Local echo state keeps typing snappy; the upstream query is pushed on a
 * short debounce so the (potentially large) grid doesn't re-filter per key.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

export function SearchBar({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const { t } = useTranslation('spriteStudio');
  const [text, setText] = useState(query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External reset (e.g. project switch blanks the query) → sync the echo.
  useEffect(() => { setText(query); }, [query]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const push = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onQuery(value), 150);
  };

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    setText('');
    onQuery('');
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={text}
        onChange={(e) => push(e.target.value)}
        placeholder={t('library.searchPlaceholder')}
        className="h-7 w-full rounded border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-primary"
      />
      {text !== '' && (
        <button
          type="button"
          onClick={clear}
          aria-label={t('library.clearSearch')}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

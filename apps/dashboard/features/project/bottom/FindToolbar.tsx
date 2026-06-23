/**
 * Find/Replace toolbar — search + replace inputs, the three matcher toggles
 * (case / whole-word / regex), a file-mask field, the live match count, and the
 * Replace-all action. Visible strings render via `{expr}` so the JSX-literal
 * i18n guard stays quiet (this surface isn't translated).
 */
import type { ReactNode } from 'react';
import { Search, CaseSensitive, WholeWord, Regex, Replace, Loader2 } from 'lucide-react';
import { Input } from '../../../components/ui/input.js';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import type { FindCtl } from './useFindReplace.js';

function Toggle({
  active, onClick, title, children,
}: { active: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'h-6 w-6 grid place-items-center rounded border text-[11px]',
        active ? 'bg-primary/20 border-primary/50 text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}

export function FindToolbar({ c }: { c: FindCtl }) {
  const { result, loading, opts } = c;
  const count = result
    ? `${result.total} match${result.total === 1 ? '' : 'es'} in ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}${result.truncated ? '+' : ''}`
    : '';

  return (
    <div className="shrink-0 border-b p-1.5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={c.query}
            onChange={(e) => c.setQuery(e.target.value)}
            placeholder={'Find in files…'}
            className="h-7 text-[12px] pl-7"
            autoFocus
          />
        </div>
        <Toggle active={opts.caseSensitive} onClick={() => c.toggle('caseSensitive')} title={'Match case'}>
          <CaseSensitive className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle active={opts.wholeWord} onClick={() => c.toggle('wholeWord')} title={'Whole word'}>
          <WholeWord className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle active={opts.regex} onClick={() => c.toggle('regex')} title={'Regular expression'}>
          <Regex className="h-3.5 w-3.5" />
        </Toggle>
        <Input
          value={opts.mask}
          onChange={(e) => c.setMask(e.target.value)}
          placeholder={'File mask (*.tsx)'}
          className="h-7 text-[11px] w-36 shrink-0"
        />
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Replace className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={c.replacement}
            onChange={(e) => c.setReplacement(e.target.value)}
            placeholder={opts.regex ? 'Replace ($1 backrefs)…' : 'Replace…'}
            className="h-7 text-[12px] pl-7"
          />
        </div>
        <Button
          size="sm"
          variant={c.armed ? 'destructive' : 'outline'}
          className="h-7 gap-1 text-xs shrink-0"
          disabled={c.replacing || loading || !result || result.fileCount === 0}
          onClick={() => void c.replaceAll()}
          title={c.armed ? 'Click again to confirm' : 'Replace all matches'}
        >
          {c.replacing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Replace className="h-3.5 w-3.5" />}
          {c.armed && result ? `Replace ${result.total}?` : 'Replace All'}
        </Button>
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground min-h-[14px]">
        {loading ? 'Searching…' : count}
        {c.replaceMsg && <span className="text-emerald-500 truncate">· {c.replaceMsg}</span>}
        {c.error && <span className="text-red-500 truncate">· {c.error}</span>}
      </div>
    </div>
  );
}

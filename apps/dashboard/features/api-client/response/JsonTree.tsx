/**
 * Collapsible JSON tree for response previews. Type-colored primitives, depth
 * guard. Falls back to raw text if the body isn't valid JSON.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

export function JsonTree({ body }: { body: string }) {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return <pre className="text-xs font-mono whitespace-pre-wrap break-words">{body}</pre>; }
  return <div className="text-xs font-mono"><Node value={data} depth={0} /></div>;
}

const PAGE = 100; // children rendered per node before a "show more" — bounds huge arrays/objects

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const { t } = useTranslation('apiClient');
  const [open, setOpen] = useState(depth < 2);
  const [shown, setShown] = useState(PAGE);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';

  if (!isObj || depth > 40) {
    return (
      <div style={{ paddingLeft: depth * 12 }} className="leading-5">
        {name !== undefined && <span className="text-sky-500">{name}: </span>}
        <Primitive value={value} />
      </div>
    );
  }

  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as object);
  const bracket = isArr ? ['[', ']'] : ['{', '}'];
  const visible = entries.slice(0, shown);
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button className="flex items-center gap-0.5 hover:text-foreground text-muted-foreground" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {name !== undefined && <span className="text-sky-500">{name}: </span>}
        <span>{bracket[0]}{!open && `… ${entries.length}`}{!open && bracket[1]}</span>
      </button>
      {open && (
        <>
          {visible.map(([k, v]) => <Node key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} />)}
          {entries.length > shown && (
            <button style={{ paddingLeft: (depth + 1) * 12 }} className="text-sky-500 hover:underline leading-5"
              onClick={() => setShown((n) => n + PAGE * 5)}>
              {t('jsonTree.showMore', { count: Math.min(PAGE * 5, entries.length - shown), hidden: entries.length - shown })}
            </button>
          )}
          <div style={{ paddingLeft: 12 }} className="text-muted-foreground">{bracket[1]}</div>
        </>
      )}
    </div>
  );
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === 'string') return <span className="text-emerald-500">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="text-amber-500">{value}</span>;
  if (typeof value === 'boolean') return <span className={cn('font-medium', value ? 'text-emerald-500' : 'text-red-400')}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}

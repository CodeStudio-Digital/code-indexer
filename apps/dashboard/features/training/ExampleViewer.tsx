/**
 * ExampleViewer — shows a dataset's generated examples so the user can eyeball
 * quality: pass outputs rendered with Shiki syntax highlighting, fail examples
 * showing the validator log. Header summarizes pass/fail counts.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge.js';
import { ScrollArea } from '../../components/ui/scroll-area.js';
import { CodeBlock } from '../builder/preview/files/viewer/CodeBlock.js';
import type { TrainingExampleDTO } from '@mcp/api-bus';
import { listExamples } from './api.js';

export function ExampleViewer({ datasetId }: { datasetId: number }) {
  const { t } = useTranslation('training');
  const [examples, setExamples] = useState<TrainingExampleDTO[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'pass' | 'fail'>('all');

  useEffect(() => {
    let cancelled = false;
    setOpen(null);
    void listExamples(datasetId).then((x) => { if (!cancelled) setExamples(x); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [datasetId]);

  const passCount = useMemo(() => examples.filter((e) => e.verdict === 'pass').length, [examples]);
  const shown = useMemo(
    () => (filter === 'all' ? examples : examples.filter((e) => e.verdict === filter)),
    [examples, filter],
  );

  if (examples.length === 0) {
    return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('noExamples')}</p>;
  }

  const Pill = ({ k, label }: { k: 'all' | 'pass' | 'fail'; label: string }) => (
    <button
      onClick={() => setFilter(k)}
      className={`rounded-full px-2.5 py-0.5 text-xs ${filter === k ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Pill k="all" label={`${t('filterAll')} ${examples.length}`} />
        <Pill k="pass" label={`✓ ${passCount}`} />
        <Pill k="fail" label={`✗ ${examples.length - passCount}`} />
      </div>
      <ScrollArea className="h-[460px] pr-3">
        <ul className="space-y-2">
          {shown.map((e) => (
            <li key={e.id} className="overflow-hidden rounded-lg border">
              <button
                onClick={() => setOpen(open === e.id ? null : e.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{e.instruction || t('generationFailed')}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {e.isHoldout && <Badge variant="outline">holdout</Badge>}
                  <Badge variant={e.verdict === 'pass' ? 'default' : 'destructive'}>{e.verdict}</Badge>
                </span>
              </button>
              {open === e.id && (
                <div className="space-y-2 border-t p-3">
                  {e.input && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{e.input}</p>}
                  {e.verdict === 'pass'
                    ? <div className="text-xs"><CodeBlock code={e.output} lang="tsx" wrap={false} lineNumbers={false} /></div>
                    : <pre className="max-h-72 overflow-auto rounded bg-muted p-2 text-xs text-destructive whitespace-pre-wrap">{e.validationLog}</pre>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Braces,
  Check,
  Copy,
  Database,
  Maximize2,
  Minimize2,
  Rows3,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { copyText } from '../../../lib/clipboard.js';
import {
  analyzeSqlForDisplay,
  parseDbQueryInput,
  parseDbQueryResult,
  parseDbQueryResultMeta,
  type DbQueryRisk,
} from './db-query-view.js';
import { Markdown } from './Markdown.js';

interface DbQueryToolViewProps {
  input?: Record<string, unknown>;
  result?: { content: string; isError?: boolean };
  variant?: 'execution' | 'approval';
  gateRisk?: 'write' | 'execute' | 'admin';
}

const RISK_STYLE: Record<DbQueryRisk, string> = {
  read: 'border-success/30 bg-success/10 text-success',
  write: 'border-warning/40 bg-warning/10 text-warning',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
  review: 'border-info/40 bg-info/10 text-info',
};

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON',
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'AS', 'DISTINCT', 'TOP',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'UNION', 'ALL',
  'WITH', 'DECLARE', 'SET', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'CONVERT', 'COALESCE',
  'ISNULL', 'DATEADD', 'COUNT', 'MIN', 'MAX', 'SUM', 'AVG', 'OVER', 'PARTITION', 'ASC', 'DESC',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
  'TABLE', 'VIEW', 'INDEX', 'PROCEDURE', 'EXEC', 'EXECUTE', 'OUTPUT', 'RETURNING', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE', 'USE',
]);

function highlightedSqlLine(line: string, lineNumber: number) {
  const tokenPattern = /(--.*$|\/\*.*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\[[^\]]*\]|@[A-Za-z_][\w$#@]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w$#@]*\b)/g;
  const parts = line.split(tokenPattern).filter((part) => part !== '');
  return parts.map((part, index) => {
    const upper = part.toUpperCase();
    const className = part.startsWith('--') || part.startsWith('/*')
      ? 'text-slate-500 italic'
      : part.startsWith("'")
        ? 'text-emerald-300'
        : part.startsWith('@')
          ? 'text-violet-300'
          : part.startsWith('[') || part.startsWith('"')
            ? 'text-cyan-200'
            : /^\d/.test(part)
              ? 'text-amber-300'
              : SQL_KEYWORDS.has(upper)
                ? 'font-semibold text-sky-300'
                : undefined;
    return <Fragment key={`${lineNumber}:${index}`}><span className={className}>{part}</span></Fragment>;
  });
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (event) => {
        event.stopPropagation();
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-background/70 px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      {copied ? 'OK' : label}
    </button>
  );
}

function SqlCode({ sql }: { sql: string }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => sql.split(/\r?\n/), [sql]);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-700/70 bg-[#0b1020] shadow-inner">
      <div className="flex items-center justify-between gap-2 border-b border-slate-700/70 bg-slate-900/80 px-2.5 py-1.5 text-slate-300">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">{t('dbQuery.sql')}</span>
        <div className="flex items-center gap-1.5">
          <CopyAction text={sql} label={t('dbQuery.copySql')} />
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950/50 px-2 text-[10px] font-medium text-slate-300 hover:bg-slate-800"
          >
            {expanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            {expanded ? t('dbQuery.collapse') : t('dbQuery.expand')}
          </button>
        </div>
      </div>
      <div className={cn('overflow-auto', expanded ? 'max-h-[72vh]' : 'max-h-80')} data-text-selectable>
        <div className="min-w-max py-2 font-mono text-[11px] leading-5 text-slate-200">
          {lines.map((line, index) => (
            <div key={index} className="flex min-h-5 hover:bg-white/[0.035]">
              <span className="sticky left-0 w-11 shrink-0 select-none border-r border-slate-800 bg-[#0b1020] pr-2 text-right text-slate-600">
                {index + 1}
              </span>
              <code className="whitespace-pre px-3">{highlightedSqlLine(line, index)}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type ResultMode = 'preview' | 'raw' | 'pretty';

function ResultModeButton({
  active,
  label,
  onClick,
  preview,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  preview?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-result-preview={preview || undefined}
      className={cn(
        'h-7 rounded-md border px-2 text-[10px] font-medium transition-colors',
        active
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'bg-background/70 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function RawResult({ content, error }: { content: string; error: boolean }) {
  return (
    <pre
      data-text-selectable
      className={cn(
        'overflow-x-auto whitespace-pre p-2.5 font-mono text-[11px] leading-5',
        error ? 'bg-destructive/[0.04] text-destructive' : 'bg-muted/10 text-foreground',
      )}
    >
      {content}
    </pre>
  );
}

function QueryResult({
  content,
  error,
  result,
  mode,
}: {
  content: string;
  error: boolean;
  result: ReturnType<typeof parseDbQueryResult>;
  mode: ResultMode;
}) {
  if (error || result.kind === 'text') return <RawResult content={content} error={error} />;

  if (result.kind === 'markdown' && mode === 'preview') {
    return (
      <div data-result-preview data-text-selectable className="overflow-x-auto bg-muted/10 px-2.5 py-2">
        <Markdown text={result.body} />
      </div>
    );
  }

  return <RawResult content={mode === 'pretty' ? result.pretty ?? content : content} error={false} />;
}

export function DbQueryToolView({ input, result, variant = 'execution', gateRisk }: DbQueryToolViewProps) {
  const { t } = useTranslation('chat');
  const query = useMemo(() => parseDbQueryInput(input), [input]);
  const analysis = useMemo(() => analyzeSqlForDisplay(query.sql), [query.sql]);
  const resultMeta = useMemo(() => parseDbQueryResultMeta(result?.content), [result?.content]);
  const resultView = useMemo(() => parseDbQueryResult(result?.content), [result?.content]);
  const [resultMode, setResultMode] = useState<ResultMode>(
    () => resultView.kind === 'markdown' ? 'preview' : 'raw',
  );
  const riskLabel = t(`dbQuery.risk.${analysis.risk}`);

  // A new result belongs to a new tool execution. Reapply the useful default
  // instead of carrying a previous card's manually-selected raw/pretty mode.
  useEffect(() => {
    setResultMode(resultView.kind === 'markdown' ? 'preview' : 'raw');
  }, [result?.content, resultView.kind]);

  if (!query.sql) {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-card p-2 font-mono text-[11px]">
        {JSON.stringify(input ?? {}, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card/70 px-2.5 py-2">
        <div className="mr-1 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Database className="h-3.5 w-3.5" />
        </div>
        <span className="font-medium text-foreground">{query.connection}</span>
        <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', RISK_STYLE[analysis.risk])}>
          {riskLabel}
        </span>
        <span className="rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {analysis.operation}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          {analysis.lineCount} {t('dbQuery.lines')}
        </span>
        {analysis.statementCount > 1 && (
          <span className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
            <Braces className="h-3 w-3" />
            {analysis.statementCount} {t('dbQuery.statements')}
          </span>
        )}
        {query.maxRows !== null && (
          <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Rows3 className="h-3 w-3" /> {t('dbQuery.maxRows', { count: query.maxRows })}
          </span>
        )}
      </div>

      {variant === 'approval' && (
        <div className={cn(
          'flex items-start gap-2 rounded-lg border p-2 text-[11px] leading-relaxed',
          analysis.risk === 'destructive'
            ? 'border-destructive/35 bg-destructive/[0.08] text-destructive'
            : 'border-warning/30 bg-warning/[0.07] text-foreground',
        )}>
          {analysis.risk === 'read' ? (
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          )}
          <span>
            {analysis.flaggedKeywords.length > 0
              ? t('dbQuery.detectedOperations', { operations: analysis.flaggedKeywords.join(', ') })
              : gateRisk === 'write'
                ? t('dbQuery.conservativeReview')
                : t('dbQuery.reviewBeforeRun')}
          </span>
        </div>
      )}

      <SqlCode sql={query.sql} />

      {query.params.length > 0 && (
        <details className="overflow-hidden rounded-lg border bg-card/60">
          <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-medium text-foreground">
            {t('dbQuery.params')} ({query.params.length})
          </summary>
          <pre className="max-h-40 overflow-auto border-t bg-muted/20 p-2.5 font-mono text-[11px] whitespace-pre">
            {JSON.stringify(query.params, null, 2)}
          </pre>
        </details>
      )}

      {result && (
        <div className={cn('overflow-hidden rounded-lg border bg-card/70', result.isError && 'border-destructive/40')}>
          <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
            <span className={cn('text-[10px] font-semibold uppercase tracking-[0.14em]', result.isError ? 'text-destructive' : 'text-muted-foreground')}>
              {result.isError ? t('messages.toolResultError') : t('dbQuery.result')}
            </span>
            {resultMeta.rows !== null && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {resultMeta.rows} {t('dbQuery.rows')}
              </span>
            )}
            {resultMeta.truncated === true && (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                {t('dbQuery.truncated')}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              {!result.isError && resultView.kind === 'markdown' && (
                <>
                  <ResultModeButton
                    active={resultMode === 'preview'}
                    label={t('dbQuery.preview')}
                    onClick={() => setResultMode('preview')}
                    preview
                  />
                  <ResultModeButton
                    active={resultMode === 'raw'}
                    label={t('dbQuery.raw')}
                    onClick={() => setResultMode('raw')}
                  />
                </>
              )}
              {!result.isError && resultView.kind === 'json' && (
                <>
                  <ResultModeButton
                    active={resultMode === 'raw'}
                    label={t('dbQuery.raw')}
                    onClick={() => setResultMode('raw')}
                  />
                  <ResultModeButton
                    active={resultMode === 'pretty'}
                    label={t('dbQuery.pretty')}
                    onClick={() => setResultMode('pretty')}
                  />
                </>
              )}
              <CopyAction text={result.content} label={t('dbQuery.copyResult')} />
            </div>
          </div>
          <QueryResult
            content={result.content}
            error={!!result.isError}
            result={resultView}
            mode={resultMode}
          />
        </div>
      )}
    </div>
  );
}

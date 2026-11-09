/**
 * Key-value data tab (Redis) — double-click a logical DB. Browses the keyspace
 * with SCAN (glob pattern + cursor "load more"), showing key · type · TTL in the
 * shared grid; the pencil per row (or "Add") opens the KeyEditor to view/edit/
 * delete. Mirrors DocumentsTab but for keys, not documents.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RefreshCw, Loader2, Plus, ChevronDown, Terminal } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { VirtualResultGrid } from '../grid/VirtualResultGrid.js';
import { KeyEditor } from './KeyEditor.js';
import type { DbQueryResult } from '../types.js';

type Row = Record<string, unknown>;
const FIELDS = [{ name: 'key' }, { name: 'type' }, { name: 'ttl' }];

/** Split a RESP command line into tokens, honouring single/double quotes. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export function KeyValueTab({ connKey, db }: { connKey: string; db: string }) {
  const { t } = useTranslation('dbClient');
  const [pattern, setPattern] = useState('*');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string | null } | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [cmd, setCmd] = useState('');
  const [cmdResult, setCmdResult] = useState<DbQueryResult | null>(null);
  const [cmdErr, setCmdErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const patternRef = useRef(pattern);
  patternRef.current = pattern;
  const reqRef = useRef(0);

  const runConsole = useCallback(async () => {
    const args = tokenize(cmd.trim());
    if (args.length === 0) return;
    setRunning(true);
    setCmdErr(null);
    try {
      const res = await api.runCommand(connKey, { kind: 'keyvalue', op: 'raw', args, payload: { db } }, 1000);
      setCmdResult(res);
    } catch (e) {
      setCmdErr(e instanceof Error ? e.message : String(e));
      setCmdResult(null);
    } finally {
      setRunning(false);
    }
  }, [cmd, connKey, db]);

  // `append` continues the SCAN cursor; otherwise it's a fresh scan from '0'.
  const runScan = useCallback(
    async (cur: string, append: boolean) => {
      const my = ++reqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.runCommand(connKey, { kind: 'keyvalue', op: 'scan', payload: { db, cursor: cur, match: patternRef.current || '*' } }, 500);
        if (my !== reqRef.current) return;
        setRows((prev) => (append ? [...prev, ...res.rows] : res.rows));
        setCursor(res.cursor ?? '0');
      } catch (e) {
        if (my === reqRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          if (!append) setRows([]);
        }
      } finally {
        if (my === reqRef.current) setLoading(false);
      }
    },
    [connKey, db],
  );

  useEffect(() => {
    void runScan('0', false);
  }, [runScan]);

  const onSaved = useCallback(() => {
    setEditing(null);
    void runScan('0', false);
  }, [runScan]);

  const hasMore = cursor !== '0';
  const result = { rows, rowCount: rows.length, fields: FIELDS };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-1.5">
        <input
          className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs outline-none"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void runScan('0', false)}
          placeholder={t('kv.patternPlaceholder')}
          spellCheck={false}
        />
        <Button size="sm" onClick={() => void runScan('0', false)} disabled={loading}>
          <Play className="mr-1.5 h-3 w-3" />
          {t('kv.scan')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing({ key: null })}>
          <Plus className="mr-1.5 h-3 w-3" />
          {t('kv.add')}
        </Button>
        <Button size="sm" variant={consoleOpen ? 'secondary' : 'ghost'} onClick={() => setConsoleOpen((o) => !o)} title={t('kv.console')}>
          <Terminal className="h-3.5 w-3.5" />
        </Button>
      </div>

      {consoleOpen && (
        <div className="flex flex-col gap-1 border-b bg-muted/30 p-1.5">
          <p className="text-xs text-muted-foreground">{t('kv.consoleAcquisition')}</p>
          <div className="flex items-center gap-2">
            <input
              className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs outline-none"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void runConsole()}
              placeholder={t('kv.consolePlaceholder')}
              spellCheck={false}
            />
            <Button size="sm" onClick={() => void runConsole()} disabled={running}>
              {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            </Button>
          </div>
          {(cmdResult || cmdErr) && (
            <div className="h-40 min-h-0">
              <VirtualResultGrid result={cmdResult} error={cmdErr} tableName="resp" />
            </div>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute right-2 top-2 z-30">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        <VirtualResultGrid result={result} error={error} tableName={`db${db}`} onRowOpen={(row) => setEditing({ key: String(row.key) })} />
      </div>

      <div className="flex items-center gap-2 border-t px-2 py-1 text-xs">
        <button className="rounded p-1 hover:bg-muted" title={t('data.reload')} onClick={() => void runScan('0', false)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <span className="text-muted-foreground">{t('kv.keysLoaded', { n: rows.length })}</span>
        <div className="flex-1" />
        {hasMore && (
          <Button size="sm" variant="ghost" onClick={() => void runScan(cursor, true)} disabled={loading}>
            <ChevronDown className="mr-1.5 h-3 w-3" />
            {t('kv.loadMore')}
          </Button>
        )}
      </div>

      {editing && (
        <KeyEditor connKey={connKey} db={db} keyName={editing.key} onClose={() => setEditing(null)} onSaved={onSaved} />
      )}
    </div>
  );
}

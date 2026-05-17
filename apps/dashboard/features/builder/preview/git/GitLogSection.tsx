import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { workspaceApi, type GitLogEntry } from '../api.js';

interface Props {
  sessionId: number;
  projectId: number;
  /** Bump to force a refetch (e.g. after a commit). */
  version?: number;
}

export function GitLogSection({ sessionId, projectId, version = 0 }: Props) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    workspaceApi
      .gitLog(sessionId, projectId, 30)
      .then((r) => { if (!cancelled) setEntries(r.entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, projectId, version]);

  return (
    <div className="border-t">
      <div className="px-3 py-1 bg-muted/10 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
        Últimos commits
      </div>
      {loading && (
        <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" /> Carregando log…
        </div>
      )}
      {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
      {!loading && !error && entries.length === 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground italic">Sem commits.</div>
      )}
      {entries.map((e) => (
        <div key={e.hash} className="px-3 py-1 text-xs font-mono border-b last:border-b-0 flex gap-2">
          <span className="text-muted-foreground shrink-0">{e.hash}</span>
          <span className="truncate">{e.subject}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Right pane: the last response — status line (colored by class), timing,
 * a headers table, and a pretty-printed body.
 */
import { useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import type { SendResponse } from './types.js';

function statusColor(s: number): string {
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

function pretty(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

interface Props {
  response: SendResponse | null;
  error: string | null;
  sending: boolean;
  verifiedStatus?: number | null;
  onMarkVerified?: (status: number) => void;
}

export function ResponseViewer({ response, error, sending, verifiedStatus, onMarkVerified }: Props) {
  const [tab, setTab] = useState<'body' | 'headers'>('body');
  const prettyBody = useMemo(() => (response ? pretty(response.body) : ''), [response]);

  if (sending) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Sending…</div>;
  }
  if (error) {
    return <div className="h-full flex items-start p-3 text-xs text-red-500 font-mono whitespace-pre-wrap">{error}</div>;
  }
  if (!response) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Send a request to see the response.</div>;
  }

  const headers = Object.entries(response.headers);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-2 border-b text-xs">
        <span className={cn('font-mono font-semibold', statusColor(response.status))}>
          {response.status} {response.statusText}
        </span>
        <span className="text-muted-foreground">{response.ms}ms</span>
        <span className="text-muted-foreground">{response.body.length} B</span>
        {onMarkVerified && (
          <Button
            size="sm" variant="ghost"
            className={cn('h-6 ml-auto gap-1 text-xs', verifiedStatus === response.status ? 'text-emerald-500' : 'text-muted-foreground')}
            title="Pin this status as the regression baseline"
            onClick={() => onMarkVerified(response.status)}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {verifiedStatus === response.status ? 'Verified' : 'Set as expected'}
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 pt-2 text-xs">
        {(['body', 'headers'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn('px-2 py-1 rounded-t capitalize', tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-2">
        {tab === 'body'
          ? <pre className="text-xs font-mono whitespace-pre-wrap break-words">{prettyBody}</pre>
          : (
            <table className="text-xs font-mono w-full">
              <tbody>
                {headers.map(([k, v]) => (
                  <tr key={k} className="border-b border-border/30">
                    <td className="pr-3 py-0.5 text-muted-foreground align-top">{k}</td>
                    <td className="py-0.5 break-all">{Array.isArray(v) ? v.join(', ') : String(v ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  );
}

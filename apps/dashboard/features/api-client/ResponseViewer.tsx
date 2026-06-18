/**
 * Right pane host: status line + response tabs (Body · Headers · Test Results ·
 * Cookies · Timing) + the "Set as expected" verify action. Delegates rendering to
 * the response/* components.
 */
import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import type { SendResponse } from './types.js';
import { SubTabs, type SubTabDef } from './SubTabs.js';
import { ResponseBody } from './response/ResponseBody.js';
import { ResponseHeaders } from './response/ResponseHeaders.js';
import { TestResultsTab } from './response/TestResultsTab.js';
import { CookiesTab } from './response/CookiesTab.js';
import { TimingTab } from './response/TimingTab.js';

function statusColor(s: number): string {
  if (s < 300) return 'text-emerald-500';
  if (s < 400) return 'text-blue-500';
  if (s < 500) return 'text-amber-500';
  return 'text-red-500';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

type Tab = 'body' | 'headers' | 'tests' | 'cookies' | 'timing';

interface Props {
  response: SendResponse | null;
  error: string | null;
  sending: boolean;
  verifiedStatus?: number | null;
  onMarkVerified?: (status: number) => void;
}

export function ResponseViewer({ response, error, sending, verifiedStatus, onMarkVerified }: Props) {
  const [tab, setTab] = useState<Tab>('body');

  if (sending) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Sending…</div>;
  if (error) return <div className="h-full flex items-start p-3 text-xs text-red-500 font-mono whitespace-pre-wrap">{error}</div>;
  if (!response) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Send a request to see the response.</div>;

  const tests = response.tests ?? [];
  const failedTests = tests.filter((t) => !t.passed).length;
  const tabs: SubTabDef<Tab>[] = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', badge: Object.keys(response.headers).length, badgeTone: 'primary' },
    { id: 'tests', label: 'Test Results', badge: failedTests || tests.length || undefined, badgeTone: failedTests ? 'danger' : 'success' },
    { id: 'cookies', label: 'Cookies', badge: response.cookies?.length, badgeTone: 'primary' },
    { id: 'timing', label: 'Timing' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-3 h-10 border-b text-xs shrink-0">
        <span className={cn('font-mono font-semibold', statusColor(response.status))}>{response.status} {response.statusText}</span>
        <span className="text-muted-foreground">{response.ms} ms</span>
        <span className="text-muted-foreground">{formatBytes(response.size ?? response.body.length)}</span>
        {onMarkVerified && (
          <Button size="sm" variant="ghost"
            className={cn('h-6 ml-auto gap-1 text-xs', verifiedStatus === response.status ? 'text-emerald-500' : 'text-muted-foreground')}
            title="Pin this status as the regression baseline" onClick={() => onMarkVerified(response.status)}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            {verifiedStatus === response.status ? 'Verified' : 'Set as expected'}
          </Button>
        )}
      </div>
      <SubTabs tabs={tabs} active={tab} onChange={setTab} />
      <div className="flex-1 min-h-0">
        {tab === 'body' && <ResponseBody body={response.body} headers={response.headers} truncated={response.truncated} />}
        {tab === 'headers' && <div className="h-full overflow-auto"><ResponseHeaders headers={response.headers} /></div>}
        {tab === 'tests' && <TestResultsTab tests={response.tests} consoleLogs={response.consoleLogs} scriptError={response.scriptError} />}
        {tab === 'cookies' && <CookiesTab cookies={response.cookies} />}
        {tab === 'timing' && <TimingTab response={response} />}
      </div>
    </div>
  );
}

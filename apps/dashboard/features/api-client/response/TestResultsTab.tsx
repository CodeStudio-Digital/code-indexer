/** pm.test() outcomes + console logs + a script-error banner. */
import { CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { ScriptTestResult } from '../types.js';

interface Props {
  tests?: ScriptTestResult[];
  consoleLogs?: string[];
  scriptError?: string;
  updatedVars?: string[];
}

export function TestResultsTab({ tests = [], consoleLogs = [], scriptError, updatedVars = [] }: Props) {
  const passed = tests.filter((t) => t.passed).length;
  if (!tests.length && !consoleLogs.length && !scriptError && !updatedVars.length) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-4 text-center">No tests. Add a Tests script with <code className="mx-1">pm.test(...)</code> in the request editor.</div>;
  }
  return (
    <div className="p-2 text-xs space-y-2 overflow-auto h-full">
      {scriptError && <div className="text-red-500 font-mono whitespace-pre-wrap">Script error: {scriptError}</div>}
      {updatedVars.length > 0 && (
        <div className="text-emerald-600">
          Saved {updatedVars.length} environment variable{updatedVars.length > 1 ? 's' : ''}: <span className="font-mono">{updatedVars.join(', ')}</span>
        </div>
      )}
      {!!tests.length && (
        <div className="text-muted-foreground">{passed}/{tests.length} passed</div>
      )}
      <div className="space-y-1">
        {tests.map((t, i) => (
          <div key={i} className="flex items-start gap-1.5">
            {t.passed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />}
            <span className={cn(!t.passed && 'text-red-500')}>{t.name}{t.error ? ` — ${t.error}` : ''}</span>
          </div>
        ))}
      </div>
      {!!consoleLogs.length && (
        <div className="pt-2 border-t">
          <div className="text-muted-foreground mb-1">Console</div>
          <pre className="font-mono whitespace-pre-wrap break-words text-muted-foreground">{consoleLogs.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

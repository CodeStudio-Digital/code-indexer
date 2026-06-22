/** pm.test() outcomes + console logs + a script-error banner. */
import { CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import type { ScriptTestResult } from '../types.js';

interface Props {
  tests?: ScriptTestResult[];
  consoleLogs?: string[];
  scriptError?: string;
  updatedVars?: string[];
}

export function TestResultsTab({ tests = [], consoleLogs = [], scriptError, updatedVars = [] }: Props) {
  const { t } = useTranslation('apiClient');
  const passed = tests.filter((t) => t.passed).length;
  if (!tests.length && !consoleLogs.length && !scriptError && !updatedVars.length) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-4 text-center">{t('tests.emptyStatePrefix')} <code className="mx-1">pm.test(...)</code> {t('tests.emptyStateSuffix')}</div>;
  }
  return (
    <div className="p-2 text-xs space-y-2 overflow-auto h-full">
      {scriptError && <div className="text-red-500 font-mono whitespace-pre-wrap">{t('tests.scriptError')} {scriptError}</div>}
      {updatedVars.length > 0 && (
        <div className="text-emerald-600">
          {t('tests.savedVars', { count: updatedVars.length })} <span className="font-mono">{updatedVars.join(', ')}</span>
        </div>
      )}
      {!!tests.length && (
        <div className="text-muted-foreground">{t('tests.passedCount', { passed, total: tests.length })}</div>
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
          <div className="text-muted-foreground mb-1">{t('tests.console')}</div>
          <pre className="font-mono whitespace-pre-wrap break-words text-muted-foreground">{consoleLogs.join('\n')}</pre>
        </div>
      )}
    </div>
  );
}

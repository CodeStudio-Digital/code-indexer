/**
 * "Restore QA config" button for Tab Testes.
 *
 * One-click recovery for the MCP-managed QA workspace artifacts when
 * the agent has stripped the streaming reporter, the html reporter, the
 * HMAC cookie injection, or `process.env.PLAYWRIGHT_BASE_URL` from
 * `playwright.config.ts`. Calls `POST /qa/restore-config` which returns
 * a typed report we render inline as a small success/warning panel.
 *
 * Idempotent: clicking when the workspace is already pristine writes
 * the same files (cheap) and reports `configMissing: []` — visible as
 * "Already pristine" feedback.
 */
import React, { useState } from 'react';
import { Button } from '../../../../components/ui/button.js';
import { RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { restoreQaConfig, type QaRestoreReport } from '../api/qa-api.js';

interface Props {
  sessionId: number;
  /** Optional: refresh the parent's data (e.g. test plan) after restore. */
  onRestored?: () => void;
}

interface OutcomeOk {
  kind: 'ok';
  report: QaRestoreReport;
}
interface OutcomeErr {
  kind: 'error';
  message: string;
}
type Outcome = OutcomeOk | OutcomeErr | null;

export function RestoreQaConfigButton({ sessionId, onRestored }: Props) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await restoreQaConfig({ sessionId });
      if (res.ok && res.report) {
        setOutcome({ kind: 'ok', report: res.report });
        onRestored?.();
      } else {
        setOutcome({
          kind: 'error',
          message: res.message ?? res.error ?? 'Restore failed',
        });
      }
    } catch (e) {
      setOutcome({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="text-xs h-7 gap-1"
        disabled={busy}
        onClick={handleClick}
        title="Re-write tests/e2e/reporter.ts + global-setup.ts; validate playwright.config.ts."
      >
        <RotateCcw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
        {busy ? 'Restoring…' : 'Restore QA config'}
      </Button>
      {outcome && <OutcomeBadge outcome={outcome} onDismiss={() => setOutcome(null)} />}
    </div>
  );
}

function OutcomeBadge({ outcome, onDismiss }: { outcome: Outcome; onDismiss: () => void }) {
  if (!outcome) return null;
  if (outcome.kind === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-destructive cursor-pointer"
        onClick={onDismiss}
        title={outcome.message}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {outcome.message.length > 40
          ? `${outcome.message.slice(0, 40)}…`
          : outcome.message}
      </span>
    );
  }

  const r = outcome.report;
  const restoredCount =
    Number(r.reporterRestored) +
    Number(r.globalSetupRestored) +
    Number(r.runConfigWritten);
  const hasWarnings = r.configMissing.length > 0 || r.warnings.length > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs cursor-pointer ${
        hasWarnings ? 'text-amber-600 dark:text-amber-500' : 'text-emerald-600 dark:text-emerald-500'
      }`}
      onClick={onDismiss}
      title={summariseReport(r)}
    >
      {hasWarnings ? (
        <AlertTriangle className="h-3.5 w-3.5" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5" />
      )}
      {hasWarnings
        ? `Restored, ${r.configMissing.length} drift${r.configMissing.length === 1 ? '' : 's'}`
        : restoredCount === 0
          ? 'Already pristine'
          : 'Restored'}
    </span>
  );
}

function summariseReport(r: QaRestoreReport): string {
  const parts: string[] = [];
  if (r.reporterRestored) parts.push('✓ tests/e2e/reporter.ts');
  if (r.globalSetupRestored) parts.push('✓ tests/e2e/global-setup.ts');
  if (r.configMissing.length > 0) {
    parts.push(`⚠ playwright.config.ts missing: ${r.configMissing.join(', ')}`);
  }
  if (r.configRecommendedWritten) {
    parts.push('Wrote playwright.config.recommended.ts — diff and merge.');
  }
  for (const w of r.warnings) parts.push(`⚠ ${w}`);
  return parts.join(' · ') || 'No changes needed.';
}

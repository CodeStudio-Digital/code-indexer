/**
 * Pure formatters for QA statuses → UI labels / icons / Tailwind colour
 * tokens. Centralised so the dashboard never inlines magic strings and
 * a future i18n pass touches one file.
 */
import type { QaRunStatus, QaTestStatus } from '../types.js';

export interface StatusVisual {
  icon: '✓' | '✗' | '⊘' | '⏳' | '⚠';
  label: string;
  /** Tailwind text colour token. Consumer combines with bg/border as needed. */
  toneClass: 'text-emerald-600' | 'text-red-600' | 'text-zinc-500' | 'text-amber-600' | 'text-sky-600';
}

const RUN_STATUS_VISUALS: Record<QaRunStatus, StatusVisual> = {
  running: { icon: '⏳', label: 'Running', toneClass: 'text-sky-600' },
  completed: { icon: '✓', label: 'Completed', toneClass: 'text-emerald-600' },
  aborted: { icon: '⊘', label: 'Aborted', toneClass: 'text-zinc-500' },
  error: { icon: '⚠', label: 'Error', toneClass: 'text-amber-600' },
};

const TEST_STATUS_VISUALS: Record<QaTestStatus, StatusVisual> = {
  passed: { icon: '✓', label: 'Passed', toneClass: 'text-emerald-600' },
  failed: { icon: '✗', label: 'Failed', toneClass: 'text-red-600' },
  skipped: { icon: '⊘', label: 'Skipped', toneClass: 'text-zinc-500' },
  'timed-out': { icon: '⚠', label: 'Timed out', toneClass: 'text-amber-600' },
  interrupted: { icon: '⚠', label: 'Interrupted', toneClass: 'text-amber-600' },
};

export function formatRunStatus(status: QaRunStatus): StatusVisual {
  return RUN_STATUS_VISUALS[status];
}

export function formatTestStatus(status: QaTestStatus): StatusVisual {
  return TEST_STATUS_VISUALS[status];
}

/**
 * "passed/failed" summary string: `12/14 passed (1 failed, 1 skipped)`.
 * When everything passed, returns a tighter `12/12 passed`.
 */
export function summariseRun(passed: number, failed: number, skipped: number): string {
  const total = passed + failed + skipped;
  if (total === 0) return 'no tests';
  if (failed === 0 && skipped === 0) return `${passed}/${total} passed`;
  const parts: string[] = [`${passed}/${total} passed`];
  const detail: string[] = [];
  if (failed > 0) detail.push(`${failed} failed`);
  if (skipped > 0) detail.push(`${skipped} skipped`);
  if (detail.length > 0) parts.push(`(${detail.join(', ')})`);
  return parts.join(' ');
}

/**
 * "12s" / "1m 24s" / "23ms" — compact human-readable duration. UI uses
 * this in tables where space is tight.
 */
export function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '—';
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

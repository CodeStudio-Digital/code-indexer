/**
 * Visual badge for either a `QaRunStatus` (run-level) or a
 * `QaTestStatus` (test-level). Composes `formatRunStatus` /
 * `formatTestStatus` from the pure formatter — components stay devoid
 * of magic strings.
 */
import React from 'react';
import {
  formatRunStatus,
  formatTestStatus,
} from '@mcp/services/qa/parsers/run-status-format.js';
import type { QaRunStatus, QaTestStatus } from './types.js';

interface Props {
  kind: 'run' | 'test';
  status: QaRunStatus | QaTestStatus;
  size?: 'sm' | 'md';
}

export function QaStatusBadge({ kind, status, size = 'sm' }: Props) {
  const visual =
    kind === 'run'
      ? formatRunStatus(status as QaRunStatus)
      : formatTestStatus(status as QaTestStatus);
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-medium ${visual.toneClass} ${padding}`}
      title={visual.label}
    >
      <span aria-hidden="true">{visual.icon}</span>
      <span>{visual.label}</span>
    </span>
  );
}

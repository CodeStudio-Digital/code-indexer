/**
 * B7 — friendly, actionable hint for a run's machine-readable
 * `error_class` (migration 189). Callers keep rendering the raw
 * `last_error` text as the detail; this component adds ONE localized
 * line above/below it telling the operator what to do.
 *
 * Defensive by design: absent/unknown classes render nothing, so rows
 * written before migration 189 (error_class undefined) and any future
 * server-side vocabulary degrade gracefully.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

const KNOWN_CLASSES = new Set([
  'sidecar_down',
  'reporter_unreachable',
  'config_invalid',
  'orphan',
]);

/** Pure: i18n key for a known class, null otherwise. Exported for tests. */
export function errorClassHintKey(errorClass: string | null | undefined): string | null {
  if (!errorClass || typeof errorClass !== 'string') return null;
  return KNOWN_CLASSES.has(errorClass) ? `qa.errorClass.${errorClass}` : null;
}

export function QaErrorClassHint({ errorClass }: { errorClass?: string | null }) {
  const { t } = useTranslation('agents');
  const key = errorClassHintKey(errorClass);
  if (!key) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
      {t(key)}
    </p>
  );
}

export type QaTranslate = (key: string, options?: Record<string, unknown>) => string;

export function summariseRunI18n(
  t: QaTranslate,
  passed: number,
  failed: number,
  skipped: number,
): string {
  const total = passed + failed + skipped;
  if (total === 0) return t('qa.summary.noTests');
  const parts: string[] = [t('qa.summary.passed', { passed, total })];
  const detail: string[] = [];
  if (failed > 0) detail.push(t('qa.summary.failed', { count: failed }));
  if (skipped > 0) detail.push(t('qa.summary.skipped', { count: skipped }));
  if (detail.length > 0) parts.push(`(${detail.join(', ')})`);
  return parts.join(' ');
}

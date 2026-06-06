import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils.js';
import type { Source } from './types.js';

const CLASS: Record<Source, string> = {
  db: 'text-emerald-600 dark:text-emerald-400',
  env: 'text-blue-600 dark:text-blue-400',
  default: 'text-muted-foreground',
  unset: 'text-muted-foreground/70',
};

/** Provenance pill: where the effective value came from (db / .env / default / unset). */
export function SourceBadge({ source }: { source: Source }) {
  const { t } = useTranslation('settings');
  return <span className={cn('text-[10px] font-mono', CLASS[source])}>· {t(`source.${source}`)}</span>;
}

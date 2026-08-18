import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import type { StreamNotice } from '../../../hooks/agent-stream/types.js';

/**
 * Renderer-side annotation about the run. Never persisted — see `StreamNotice`.
 */
export function NoticeBlock({ notice }: { notice: StreamNotice }) {
  const { t } = useTranslation('chat');
  if (notice.kind !== 'ultra_turn') return null;
  return (
    <div className="my-2 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
      <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
      <span>
        <span className="font-medium text-foreground">{t('notice.ultraTurnTitle')}</span>
        {' — '}
        {t('notice.ultraTurnBody')}
      </span>
    </div>
  );
}

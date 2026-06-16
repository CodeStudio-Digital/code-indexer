import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * Drop affordance shown while a file is dragged over a composer. The parent
 * container must be `position: relative`. `pointer-events-none` keeps the
 * overlay from intercepting the drop — the event lands on the underlying
 * element that owns the `useFileDrop` handlers.
 */
export function DropOverlay({ show }: { show: boolean }) {
  const { t } = useTranslation('chat');
  if (!show) return null;
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px] pointer-events-none"
      aria-hidden
    >
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <Upload className="h-4 w-4" />
        {t('composer.dropFiles', { defaultValue: 'Solte os arquivos para anexar' })}
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog.js';
import { Button } from './ui/button.js';
import { LOGO_MARK_URL } from '../lib/public-asset.js';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Navigate to the docs route and close (wired by the app menu). */
  onDocs: () => void;
}

/** Small "About CodeStudio" card — brand mark, tagline and the app version. */
export function AboutDialog({ open, onOpenChange, onDocs }: AboutDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <img src={LOGO_MARK_URL} alt="" className="h-12 w-12" draggable={false} />
          <DialogTitle>{t('about.title')}</DialogTitle>
          <DialogDescription>{t('about.tagline')}</DialogDescription>
          <span className="text-xs text-muted-foreground">
            {t('about.version', { version: __APP_VERSION__ })}
          </span>
          <Button variant="outline" size="sm" className="mt-1" onClick={onDocs}>
            {t('about.docs')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { ChevronLeft, ChevronRight, ImageIcon, ZoomIn, ZoomOut } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog.js';

interface GalleryImage { name: string; src: string; thumbnail?: string }

/** Portaled viewer stays outside transformed/virtualized transcript rows. */
export function ImageGallery({ images, compact = false }: { images: GalleryImage[]; compact?: boolean }) {
  const { t } = useTranslation('chat');
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = selected == null ? undefined : images[selected];
  const select = (index: number) => { setSelected(index); setZoom(false); setFailed(false); };
  const move = (offset: number) => select(((selected ?? 0) + offset + images.length) % images.length);
  return <>
    <div className="my-1 flex max-w-[34rem] flex-wrap gap-1.5" aria-label={t('gallery.attachments')}>
      {images.map((image, index) => <button key={`${image.name}-${index}`} type="button" onClick={() => select(index)}
        title={image.name} aria-label={t('gallery.open', { index: index + 1, name: image.name })}
        className={`group/image flex ${compact ? 'w-10 shrink-0' : 'w-32'} flex-col overflow-hidden rounded-lg border border-border/50 bg-muted/40 text-left hover:border-primary/60`}>
        <img src={image.thumbnail || image.src} alt={image.name} loading="lazy" decoding="async"
          className={`${compact ? 'h-10' : 'h-24'} w-full object-contain bg-black/15 p-1`} />
        {!compact && <span className="w-full truncate px-2 py-1 text-[10px] text-muted-foreground">{image.name}</span>}
      </button>)}
    </div>
    <Dialog open={current != null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent aria-describedby={undefined} className="flex h-[90vh] w-[94vw] max-w-[94vw] flex-col gap-2 p-3"
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
          if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
        }}>
        <div className="flex min-h-7 items-center gap-2 pr-8">
          <ImageIcon className="h-4 w-4 shrink-0" />
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{current?.name}</DialogTitle>
          <span className="text-xs text-muted-foreground">{(selected ?? 0) + 1}/{images.length}</span>
          <button type="button" aria-label={zoom ? t('gallery.fit') : t('gallery.original')} onClick={() => setZoom(!zoom)} className="rounded p-1 hover:bg-muted">
            {zoom ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
          </button>
          {images.length > 1 && <>
            <button type="button" aria-label={t('gallery.previous')} onClick={() => move(-1)}><ChevronLeft className="h-5 w-5" /></button>
            <button type="button" aria-label={t('gallery.next')} onClick={() => move(1)}><ChevronRight className="h-5 w-5" /></button>
          </>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded bg-black/20">
          {failed ? <p role="alert" className="p-4 text-sm">{t('gallery.failed')}</p>
            : current && <img key={current.src} src={current.src} alt={current.name} onError={() => setFailed(true)}
              className={zoom ? 'max-w-none' : 'h-full w-full object-contain'} />}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

/**
 * RefSlots — up to 3 reference-image slots for generation (the fidelity path:
 * the model SEES these, like attaching an image in the Gemini/ChatGPT web UI).
 * Sources: drag a library asset (application/x-sprite-asset MIME → its current
 * version id) or pick/drop a disk file (downscaled client-side to ≤768px and
 * sent inline as base64). The parent owns the ref list state.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus, X } from 'lucide-react';
import { versionThumbUrl } from '../api.js';
import { readAssetDragData } from '../library/asset-drag.js';

export type GenRef =
  | { kind: 'version'; versionId: number; label: string }
  | { kind: 'upload'; base64: string; mediaType: string; label: string; dataUrl: string };

export const MAX_REFS = 3;

/** Downscale a file to ≤768px (longest side) and return raw base64 + preview. */
export async function fileToUploadRef(file: File): Promise<GenRef> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 768 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const dataUrl = canvas.toDataURL('image/png');
  return {
    kind: 'upload',
    base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mediaType: 'image/png',
    label: file.name,
    dataUrl,
  };
}

export function RefSlots({
  projectId,
  refs,
  onChange,
}: {
  projectId: number;
  refs: GenRef[];
  onChange: (refs: GenRef[]) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const add = (ref: GenRef) => {
    if (refs.length >= MAX_REFS) return;
    onChange([...refs, ref]);
  };

  const removeAt = (i: number) => onChange(refs.filter((_, idx) => idx !== i));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const asset = readAssetDragData(e.dataTransfer);
    if (asset?.versionId != null) {
      add({ kind: 'version', versionId: asset.versionId, label: asset.slug });
      return;
    }
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      void fileToUploadRef(file).then(add).catch(() => undefined);
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void fileToUploadRef(file).then(add).catch(() => undefined);
  };

  return (
    <div
      className="flex items-center gap-1.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <span className="text-[11px] text-muted-foreground">{t('generate.refs.label')}</span>
      {refs.map((r, i) => (
        <div
          key={`${r.kind}-${i}`}
          className="group relative h-9 w-9 shrink-0 rounded border border-border bg-[repeating-conic-gradient(#80808033_0_25%,transparent_0_50%)] bg-[length:8px_8px]"
          title={r.label}
        >
          <img
            src={r.kind === 'version' ? versionThumbUrl(projectId, r.versionId, 64) : r.dataUrl}
            alt={r.label}
            className="h-full w-full rounded object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
          <button
            type="button"
            onClick={() => removeAt(i)}
            title={t('generate.refs.remove')}
            aria-label={t('generate.refs.remove')}
            className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-background text-muted-foreground shadow ring-1 ring-border hover:text-red-400 group-hover:flex"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {refs.length < MAX_REFS && (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          title={t('generate.refs.addHint')}
          aria-label={t('generate.refs.addHint')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <ImagePlus className="h-4 w-4" />
        </button>
      )}
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
    </div>
  );
}

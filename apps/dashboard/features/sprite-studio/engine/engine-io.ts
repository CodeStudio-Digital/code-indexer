/**
 * Canvas-touching I/O helpers kept out of the EditorEngine facade:
 * image → ImageData conversion and ImageData → PNG encoding.
 */
export function imageDataFromSource(src: ImageData | HTMLImageElement): ImageData {
  if (src instanceof ImageData) return src;
  const c = document.createElement('canvas');
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function pngBlobFromImageData(img: ImageData): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  (c.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

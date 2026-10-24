import sharp from 'sharp';

export const MAX_VISION_SOURCE_BYTES = 64 * 1024 * 1024;
export interface ImageCrop { left: number; top: number; width: number; height: number }

/** Decode under a pixel budget; normalize formats and send only the requested detail. */
export async function prepareVisionImage(bytes: Buffer, options: { crop?: ImageCrop; maxDimension?: number } = {}) {
  if (bytes.length > MAX_VISION_SOURCE_BYTES) throw new Error('Image exceeds the 64 MB source limit.');
  const image = sharp(bytes, { limitInputPixels: 100_000_000, animated: false });
  const metadata = await image.metadata();
  const crop = options.crop;
  if (crop && (!Object.values(crop).every(Number.isSafeInteger) || crop.left < 0 || crop.top < 0
    || crop.width <= 0 || crop.height <= 0 || crop.left + crop.width > (metadata.width ?? 0)
    || crop.top + crop.height > (metadata.height ?? 0))) throw new Error('Crop must fit within the source image.');
  const maxDimension = options.maxDimension ?? 2048;
  if (!Number.isInteger(maxDimension) || maxDimension < 64 || maxDimension > 4096) {
    throw new Error('max_dimension must be an integer from 64 to 4096.');
  }
  if (crop) image.extract(crop);
  const { data, info } = await image.rotate().resize(maxDimension, maxDimension, {
    fit: 'inside', withoutEnlargement: true,
  }).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
  if (data.length > 8 * 1024 * 1024) throw new Error('Preview exceeds 8 MB; use a smaller max_dimension or crop.');
  return { base64: data.toString('base64'), mediaType: 'image/webp',
    width: metadata.width, height: metadata.height, previewWidth: info.width, previewHeight: info.height };
}

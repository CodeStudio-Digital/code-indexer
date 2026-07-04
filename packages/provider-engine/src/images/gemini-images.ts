import type {
  ImageGenCapabilities,
  ImageGenClient,
  ImageGenRequest,
  ImageGenResult,
  GeneratedImage,
  ImageRef,
  ResolvedCreds,
} from '@mcp/provider-sdk';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
/** Gemini image conditioning works best with few references. */
const MAX_REFERENCE_IMAGES = 3;

/** Map a WxH size hint to Gemini's imageSize tier — default to the cheapest. */
function imageSizeOf(size?: string): string {
  const dim = size ? Math.max(...size.split('x').map((v) => Number(v) || 0)) : 0;
  if (dim >= 3000) return '4K';
  if (dim >= 1500) return '2K';
  return '1K';
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Gemini image generation via `models/{model}:generateContent` with
 * `responseModalities: ['TEXT','IMAGE']` (gemini-*-image family / "nano
 * banana", imagen-backed ids surfaced by discovery). References ride as
 * `inline_data` parts — img2img/character conditioning is native; there is no
 * true mask or alpha output (callers key-color + remove locally).
 */
export class GeminiImagesClient implements ImageGenClient {
  private readonly baseURL: string;

  constructor(
    private readonly creds: ResolvedCreds,
    private readonly boundModel?: string,
  ) {
    this.baseURL = (creds.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  capabilities(): ImageGenCapabilities {
    return {
      edit: true,
      mask: false,
      transparentBackground: false,
      seed: false,
      negativePrompt: false,
      maxReferenceImages: MAX_REFERENCE_IMAGES,
    };
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model ?? this.boundModel;
    if (!model) throw new Error('gemini-images: no model bound or requested');
    const refs = req.referenceImages ?? [];
    if (refs.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`gemini-images: at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
    // No native n: loop sequentially so aborts cancel promptly between calls.
    const n = Math.max(1, req.n ?? 1);
    const images: GeneratedImage[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (let i = 0; i < n; i++) {
      req.signal?.throwIfAborted();
      const one = await this.generateOne(model, req.prompt, refs, imageSizeOf(req.size), req.signal);
      images.push(...one.images);
      inputTokens += one.usage?.inputTokens ?? 0;
      outputTokens += one.usage?.outputTokens ?? 0;
      req.onProgress?.({ pct: Math.round(((i + 1) / n) * 100) });
    }
    return { images, usage: { inputTokens, outputTokens } };
  }

  private async generateOne(
    model: string,
    prompt: string,
    refs: ImageRef[],
    imageSize: string,
    signal?: AbortSignal,
  ): Promise<ImageGenResult> {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const ref of refs) {
      parts.push({ inline_data: { mime_type: ref.mediaType, data: ref.base64 } });
    }
    const url = `${this.baseURL}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.creds.apiKey ?? '')}`;
    const f = this.creds.fetch ?? fetch;
    const call = (withImageConfig: boolean) =>
      f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.creds.extraHeaders },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            // Output tokens scale with image size (a 4K image bills ~4x a 1K
            // one) — sprites get downscaled to a tiny grid anyway, so ask for
            // the cheapest tier the model supports.
            ...(withImageConfig ? { imageConfig: { imageSize } } : {}),
          },
        }),
        signal,
      });
    let res = await call(true);
    if (res.status === 400) {
      // Older image models (gemini-2.5-flash-image) reject imageConfig — the
      // 400 body names the unknown field. Retry once without it.
      const body = await res.text().catch(() => '');
      if (/image_?config|image_?size/i.test(body)) {
        res = await call(false);
      } else if (!res.ok) {
        throw new Error(`gemini-images: HTTP 400 — ${body.slice(0, 600)}`);
      }
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 600);
      throw new Error(`gemini-images: HTTP ${res.status} — ${text || res.statusText}`);
    }
    const json = (await res.json()) as GeminiGenerateResponse;
    const images: GeneratedImage[] = [];
    for (const cand of json.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        const data = part.inlineData?.data;
        if (typeof data === 'string' && data.length > 0) {
          images.push({ base64: data, mediaType: part.inlineData?.mimeType ?? 'image/png' });
        }
      }
    }
    if (!images.length) throw new Error('gemini-images: response contained no image parts');
    return {
      images,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

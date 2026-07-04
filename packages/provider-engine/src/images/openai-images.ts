import type {
  ImageGenCapabilities,
  ImageGenClient,
  ImageGenRequest,
  ImageGenResult,
  GeneratedImage,
  ResolvedCreds,
} from '@mcp/provider-sdk';

const DEFAULT_BASE = 'https://api.openai.com/v1';
/** gpt-image edits accept several references (mirrors codex MAX_EDIT_IMAGES). */
const MAX_EDIT_IMAGES = 5;

interface OpenAIImageDatum {
  b64_json?: string;
  revised_prompt?: string;
}

interface OpenAIImagesResponse {
  data?: OpenAIImageDatum[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * OpenAI Images API client (`/images/generations` + `/images/edits`).
 * Family-aware: gpt-image-* supports edits with multiple references, mask
 * inpainting and native transparent background; dall-e-* is txt2img-focused
 * (dall-e-2 edit path intentionally not exposed — bind a gpt-image model).
 */
export class OpenAIImagesClient implements ImageGenClient {
  private readonly baseURL: string;

  constructor(
    private readonly creds: ResolvedCreds,
    private readonly boundModel?: string,
  ) {
    this.baseURL = (creds.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  capabilities(): ImageGenCapabilities {
    const gptImage = /^gpt-image/.test(this.boundModel ?? '');
    return {
      edit: gptImage,
      mask: gptImage,
      transparentBackground: gptImage,
      seed: false,
      negativePrompt: false,
      maxReferenceImages: gptImage ? MAX_EDIT_IMAGES : 0,
    };
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model ?? this.boundModel;
    if (!model) throw new Error('openai-images: no model bound or requested');
    const refs = req.referenceImages ?? [];
    if (refs.length > MAX_EDIT_IMAGES) {
      throw new Error(`openai-images: at most ${MAX_EDIT_IMAGES} reference images`);
    }
    const res = refs.length
      ? await this.edit(model, req)
      : await this.generateNew(model, req);
    return this.parse(res);
  }

  private async generateNew(model: string, req: ImageGenRequest): Promise<Response> {
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: req.n ?? 1,
    };
    if (req.size) body.size = req.size;
    if (req.quality && req.quality !== 'auto') body.quality = req.quality;
    if (req.background && req.background !== 'auto') body.background = req.background;
    // dall-e-* requires response_format for base64; gpt-image-* rejects the
    // param (it always returns b64_json).
    if (/^dall-e/.test(model)) body.response_format = 'b64_json';
    return this.doFetch(`${this.baseURL}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }

  private async edit(model: string, req: ImageGenRequest): Promise<Response> {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', req.prompt);
    form.set('n', String(req.n ?? 1));
    if (req.size) form.set('size', req.size);
    if (req.quality && req.quality !== 'auto') form.set('quality', req.quality);
    if (req.background && req.background !== 'auto') form.set('background', req.background);
    for (const [i, ref] of (req.referenceImages ?? []).entries()) {
      form.append('image[]', refToBlob(ref), `reference-${i}.${extOf(ref.mediaType)}`);
    }
    if (req.mask) form.set('mask', refToBlob(req.mask), `mask.${extOf(req.mask.mediaType)}`);
    return this.doFetch(`${this.baseURL}/images/edits`, {
      method: 'POST',
      // content-type intentionally omitted: fetch sets the multipart boundary.
      headers: this.authHeaders(),
      body: form,
      signal: req.signal,
    });
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.creds.extraHeaders };
    if (this.creds.apiKey) headers.authorization = `Bearer ${this.creds.apiKey}`;
    return headers;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.creds.fetch ?? fetch;
    const res = await f(url, init);
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 600);
      throw new Error(`openai-images: HTTP ${res.status} — ${text || res.statusText}`);
    }
    return res;
  }

  private async parse(res: Response): Promise<ImageGenResult> {
    const json = (await res.json()) as OpenAIImagesResponse;
    const images: GeneratedImage[] = (json.data ?? [])
      .filter((d) => typeof d.b64_json === 'string' && d.b64_json.length > 0)
      .map((d) => ({
        base64: d.b64_json as string,
        mediaType: 'image/png',
        revisedPrompt: d.revised_prompt,
      }));
    if (!images.length) throw new Error('openai-images: response contained no image data');
    const usage = json.usage
      ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
      : null;
    return { images, usage };
  }
}

function refToBlob(ref: { base64: string; mediaType: string }): Blob {
  return new Blob([Buffer.from(ref.base64, 'base64')], { type: ref.mediaType });
}

function extOf(mediaType: string): string {
  if (mediaType.includes('jpeg') || mediaType.includes('jpg')) return 'jpg';
  if (mediaType.includes('webp')) return 'webp';
  return 'png';
}

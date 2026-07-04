import { randomUUID } from 'node:crypto';
import type {
  ImageGenCapabilities,
  ImageGenClient,
  ImageGenRequest,
  ImageGenResult,
  GeneratedImage,
  ResolvedCreds,
} from '@mcp/provider-sdk';

const DEFAULT_BASE = 'https://chatgpt.com/backend-api/codex';
/** Codex's standalone image tool default (mirrors ext/image-generation). */
const DEFAULT_MODEL = 'gpt-image-2';
const MAX_EDIT_IMAGES = 5;

interface CodexImageDatum {
  b64_json?: string;
}

interface CodexImagesResponse {
  data?: CodexImageDatum[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * ChatGPT-subscription image client — the Codex backend's standalone
 * `images/generations` + `images/edits` endpoints (JSON both ways; edit
 * references ride as data URIs, no multipart). Bills against the user's
 * ChatGPT plan quota instead of per-image API pricing — the exact surface
 * Codex CLI's imagegen tool uses (.referece/codex/.../ext/image-generation).
 * Headers mirror the codex chat wire (originator/UA/session + account id).
 */
export class ChatGPTImagesClient implements ImageGenClient {
  private readonly baseURL: string;
  private readonly sessionId = randomUUID();

  constructor(
    private readonly creds: ResolvedCreds,
    private readonly boundModel?: string,
  ) {
    this.baseURL = (creds.baseURL ?? DEFAULT_BASE).replace(/\/+$/, '');
  }

  capabilities(): ImageGenCapabilities {
    return {
      edit: true,
      // ImageEditRequest carries no mask field on this backend.
      mask: false,
      transparentBackground: true,
      seed: false,
      negativePrompt: false,
      maxReferenceImages: MAX_EDIT_IMAGES,
    };
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model ?? this.boundModel ?? DEFAULT_MODEL;
    const refs = req.referenceImages ?? [];
    if (refs.length > MAX_EDIT_IMAGES) {
      throw new Error(`chatgpt-images: at most ${MAX_EDIT_IMAGES} reference images`);
    }
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.n && req.n > 1) body.n = req.n;
    if (req.size) body.size = req.size;
    if (req.quality && req.quality !== 'auto') body.quality = req.quality;
    if (req.background && req.background !== 'auto') body.background = req.background;
    let path = 'images/generations';
    if (refs.length > 0) {
      path = 'images/edits';
      body.images = refs.map((r) => ({ image_url: `data:${r.mediaType};base64,${r.base64}` }));
    }

    const f = this.creds.fetch ?? fetch;
    const res = await f(`${this.baseURL}/${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 600);
      throw new Error(`chatgpt-images: HTTP ${res.status} — ${text || res.statusText}`);
    }
    const json = (await res.json()) as CodexImagesResponse;
    const images: GeneratedImage[] = (json.data ?? [])
      .filter((d) => typeof d.b64_json === 'string' && d.b64_json.length > 0)
      .map((d) => ({ base64: d.b64_json as string, mediaType: 'image/png' }));
    if (!images.length) throw new Error('chatgpt-images: response contained no image data');
    const usage = json.usage
      ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens }
      : null;
    return { images, usage };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.1.0',
      session_id: this.sessionId,
      ...this.creds.extraHeaders,
    };
    if (this.creds.apiKey) headers.authorization = `Bearer ${this.creds.apiKey}`;
    const accountId = this.creds.extra?.accountId;
    if (typeof accountId === 'string' && accountId) headers['ChatGPT-Account-Id'] = accountId;
    return headers;
  }
}

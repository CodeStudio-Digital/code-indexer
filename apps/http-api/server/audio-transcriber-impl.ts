/**
 * Audio transcriber — MAIN-SIDE implementation of speech-to-text (STT).
 *
 * Resolves the `code-agent/transcription` Pipelines role to a (provider, model)
 * and POSTs the recorded audio to an OpenAI-compatible
 * `POST {base_url}/audio/transcriptions` endpoint (Whisper style). Works with
 * OpenAI whisper-1/gpt-4o-transcribe, Groq whisper-large-v3, and self-hosted
 * whisper.cpp / faster-whisper servers.
 *
 * Mirrors `vision-describer-impl.ts` but simpler: STT is invoked only from the
 * `POST /api/coder/transcribe` HTTP route in the main process (the composer mic
 * button), so there is NO process-global singleton and NO worker bridge — and
 * no cache (each recording is unique). When no row is bound, `transcribe`
 * throws `TRANSCRIPTION_NOT_CONFIGURED` and the route degrades to HTTP 412.
 *
 * NOTE: the OpenAI `ChatProvider` adapter only speaks chat-completions, so we
 * hit the audio endpoint directly with `fetch` + `FormData`. The OpenAI
 * provider definition has no `defaultBaseURL`, so the `https://api.openai.com/v1`
 * fallback below is load-bearing for OpenAI rows with a null `base_url`.
 */
import type { PipelineProviderResolver } from '@mcp/services/pipelines/provider-resolver.js';

export const TRANSCRIPTION_NOT_CONFIGURED = 'TRANSCRIPTION_NOT_CONFIGURED';

export interface TranscribeRequest {
  /** Base64-encoded audio bytes (no data: prefix). */
  base64: string;
  /** MIME type of the recording, e.g. `audio/webm;codecs=opus`. */
  mediaType: string;
  /** Optional ISO-639-1 hint (e.g. `pt`). Omit for auto-detect. */
  language?: string;
}

export interface IAudioTranscriber {
  transcribe(req: TranscribeRequest): Promise<string>;
}

export interface AudioTranscriberDeps {
  resolver: PipelineProviderResolver;
}

/** Map a recording MIME type to a file extension the STT endpoint can sniff. */
function extFor(mediaType: string): string {
  const base = mediaType.split(';', 1)[0].trim().toLowerCase();
  switch (base) {
    case 'audio/webm': return 'webm';
    case 'audio/ogg': return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a': return 'mp4';
    case 'audio/mpeg':
    case 'audio/mp3': return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave': return 'wav';
    default: return 'webm';
  }
}

export function createAudioTranscriber(deps: AudioTranscriberDeps): IAudioTranscriber {
  return {
    async transcribe(req: TranscribeRequest): Promise<string> {
      const bind = await deps.resolver.resolveOrNull('code-agent', 'transcription', {});
      if (!bind) {
        throw new Error(
          `${TRANSCRIPTION_NOT_CONFIGURED}: no transcription model is bound. Set the ` +
            `code-agent / transcription role in Settings → Pipelines.`,
        );
      }

      // Credentials come straight off the resolved provider (api_key is already
      // decrypted — see services/providers/factory.ts). Fall back to the OpenAI
      // public endpoint + env key when the row leaves them null.
      const baseURL = (bind.provider.base_url ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      const apiKey = bind.provider.api_key ?? process.env.OPENAI_API_KEY ?? '';
      const cfg = (bind.config ?? {}) as Record<string, unknown>;

      const bytes = Buffer.from(req.base64, 'base64');
      // Buffer.from is lenient: garbage base64 decodes to an empty/truncated
      // buffer instead of throwing. Reject an empty decode early rather than
      // paying for an upstream round-trip that returns a confusing result.
      if (bytes.length === 0) throw new Error('STT: empty or invalid audio payload');
      const ext = extFor(req.mediaType);
      const kb = Math.max(1, Math.round(bytes.length / 1024));
      try {
        console.error(`[stt] transcribe ~${kb}KB via ${bind.provider.id}/${bind.modelId} (${ext})`);
      } catch { /* noop */ }

      const form = new FormData();
      form.append('file', new Blob([bytes], { type: req.mediaType }), `audio.${ext}`);
      form.append('model', bind.modelId);
      form.append('response_format', String(cfg.response_format ?? 'json'));
      if (req.language) form.append('language', req.language);
      if (cfg.temperature != null) form.append('temperature', String(cfg.temperature));

      // Bound the upstream call: a hung/half-open STT server must not pin the
      // request (and the renderer's spinner) forever. Mirrors the AbortController
      // timeout pattern in @mcp/services/quality/llm-chat.ts.
      const rawTimeout = Number(cfg.timeout_ms ?? cfg.timeout);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.max(5_000, rawTimeout) : 60_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Do NOT set content-type — fetch derives the multipart boundary.
        const res = await fetch(`${baseURL}/audio/transcriptions`, {
          method: 'POST',
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body: form,
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`STT HTTP ${res.status}: ${detail.slice(0, 300)}`);
        }

        // Read the body once. Prefer JSON ({ text }) — fall back to raw text,
        // and still try JSON if the provider mislabels the content-type.
        const ct = res.headers.get('content-type') ?? '';
        const raw = (await res.text()).trim();
        if (ct.includes('application/json') || raw.startsWith('{')) {
          try {
            return String((JSON.parse(raw) as { text?: string }).text ?? '').trim();
          } catch { /* not JSON after all — fall through to raw */ }
        }
        return raw;
      } catch (e) {
        if (controller.signal.aborted) throw new Error(`STT timeout after ${timeoutMs}ms`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

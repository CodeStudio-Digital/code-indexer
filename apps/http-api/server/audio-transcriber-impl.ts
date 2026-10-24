/**
 * Audio transcriber — MAIN-SIDE speech-to-text (STT) for the composer mic.
 *
 * Resolves the `code-agent/transcription` Pipelines role and transcribes by one
 * of two paths, chosen by provider KIND:
 *   1. Native-multimodal providers (Gemini) — routed through `provider.chat()`
 *      with the audio as an inline content block (the adapter encodes it as
 *      `inlineData`/`generateContent`). Mirrors the vision-fallback describer.
 *   2. OpenAI-Whisper-compatible providers (OpenAI, Groq, self-hosted
 *      whisper.cpp/faster-whisper) — a multipart `POST {base_url}/audio/transcriptions`.
 *
 * Why the split: Gemini has NO `/audio/transcriptions` endpoint and stores no
 * `base_url`, so the old "always hit {base_url}/audio/transcriptions with an
 * OpenAI fallback" leaked the Gemini key to api.openai.com (401). The REST path
 * now only defaults to OpenAI when the kind is actually `openai`.
 *
 * Invoked only from the `POST /api/coder/transcribe` HTTP route in the main
 * process — no global singleton, no worker bridge. When no row is bound,
 * `transcribe` throws `TRANSCRIPTION_NOT_CONFIGURED` (the route → HTTP 412).
 */
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import type { PipelineProviderResolver, ResolvedBinding } from '@mcp/services/pipelines/provider-resolver.js';
import type { AgentMessage } from "@mcp/provider-sdk";

export const TRANSCRIPTION_NOT_CONFIGURED = 'TRANSCRIPTION_NOT_CONFIGURED';

/** Provider kinds whose chat models accept audio natively (no Whisper REST). */
const CHAT_AUDIO_KINDS = new Set(['gemini', 'google-oauth']);

const TRANSCRIBE_SYSTEM =
  'You are a speech-to-text transcriber. Transcribe the provided audio recording verbatim into ' +
  'plain text. Output ONLY the transcript — no commentary, no timestamps, no speaker labels, no ' +
  'markdown fences. Preserve the spoken language. If the audio is silent or unintelligible, output nothing.';
const TRANSCRIBE_PROMPT = 'Transcribe this audio recording verbatim.';

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

/** Gemini & friends: hand the audio to a chat model as an inline content block. */
async function transcribeViaChat(bind: ResolvedBinding, req: TranscribeRequest): Promise<string> {
  const provider = await createCoderProvider(bind.provider.id, bind.modelId);
  const messages: AgentMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: TRANSCRIBE_PROMPT },
        { type: 'document', name: `audio.${extFor(req.mediaType)}`, mediaType: req.mediaType, base64: req.base64 },
      ],
    },
  ];
  let text = '';
  for await (const delta of provider.chat({ system: TRANSCRIBE_SYSTEM, messages, tools: [] })) {
    if (delta.type === 'text_delta') text += delta.text;
    if (delta.type === 'done') break;
  }
  return text.trim();
}

/** OpenAI / Groq / local whisper: multipart POST to /audio/transcriptions. */
async function transcribeViaWhisperRest(bind: ResolvedBinding, req: TranscribeRequest): Promise<string> {
  const kind = (bind.provider.kind ?? '').toLowerCase();
  // Only fall back to OpenAI's endpoint when the provider IS OpenAI — never send
  // a non-OpenAI key to api.openai.com.
  const baseURL = (bind.provider.base_url?.trim() || (kind === 'openai' ? 'https://api.openai.com/v1' : '')).replace(/\/$/, '');
  if (!baseURL) {
    throw new Error(
      `STT: transcription provider '${bind.provider.id}' (kind=${kind}) has no base_url and isn't OpenAI. ` +
        `Use a Gemini model, or an OpenAI/Groq/Whisper provider whose base_url exposes /audio/transcriptions.`,
    );
  }
  const apiKey = bind.provider.api_key || (kind === 'openai' ? process.env.OPENAI_API_KEY ?? '' : '');
  const cfg = (bind.config ?? {}) as Record<string, unknown>;

  const bytes = Buffer.from(req.base64, 'base64');
  if (bytes.length === 0) throw new Error('STT: empty or invalid audio payload');
  const ext = extFor(req.mediaType);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: req.mediaType }), `audio.${ext}`);
  form.append('model', bind.modelId);
  form.append('response_format', String(cfg.response_format ?? 'json'));
  if (req.language) form.append('language', req.language);
  if (cfg.temperature != null) form.append('temperature', String(cfg.temperature));

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
      const kind = (bind.provider.kind ?? '').toLowerCase();
      const kb = Math.max(1, Math.round((req.base64.length * 3) / 4 / 1024));
      try {
        console.error(`[stt] transcribe ~${kb}KB via ${bind.provider.id}/${bind.modelId} (kind=${kind})`);
      } catch { /* noop */ }

      return CHAT_AUDIO_KINDS.has(kind)
        ? transcribeViaChat(bind, req)
        : transcribeViaWhisperRest(bind, req);
    },
  };
}

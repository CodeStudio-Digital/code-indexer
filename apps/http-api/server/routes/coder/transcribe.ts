/**
 * POST /api/coder/transcribe — speech-to-text for the composer mic button.
 *
 * Accepts a base64 audio recording, resolves the `code-agent/transcription`
 * Pipelines role and returns the transcript. The renderer reads the recorded
 * Blob to base64 (same shape as composer attachments) and inserts the returned
 * `text` into the message input.
 *
 *   400  no_audio                     → empty body
 *   412  transcription_not_configured → no model bound (UI points to Pipelines)
 *   502  transcription_failed         → upstream STT provider error
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  createAudioTranscriber,
  TRANSCRIPTION_NOT_CONFIGURED,
} from '../../audio-transcriber-impl.js';

interface TranscribeBody {
  base64?: string;
  mediaType?: string;
  language?: string;
}

// Cap the base64 payload before decoding/buffering. ~30 MB of base64 ≈ 22 MB
// of audio — far above a 2-minute opus clip (the renderer's maxDuration), but
// a guard against a runaway/oversized POST OOMing the in-process main thread.
const MAX_BASE64_LEN = 30 * 1024 * 1024;

export function mountCoderTranscribeRoutes(app: Hono, deps: ServerDeps): void {
  const transcriber = createAudioTranscriber({ resolver: deps.pipelineProviderResolver });

  app.post('/api/coder/transcribe', async (c) => {
    const body = await c.req.json<TranscribeBody>().catch(() => ({} as TranscribeBody));
    if (!body.base64) return c.json({ error: 'no_audio' }, 400);
    if (body.base64.length > MAX_BASE64_LEN) return c.json({ error: 'audio_too_large' }, 413);

    try {
      const text = await transcriber.transcribe({
        base64: body.base64,
        mediaType: body.mediaType ?? 'audio/webm',
        language: body.language,
      });
      return c.json({ text });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes(TRANSCRIPTION_NOT_CONFIGURED)) {
        return c.json({ error: 'transcription_not_configured', detail: msg }, 412);
      }
      try { console.error('[stt] transcribe failed:', msg); } catch { /* noop */ }
      return c.json({ error: 'transcription_failed', detail: msg }, 502);
    }
  });
}

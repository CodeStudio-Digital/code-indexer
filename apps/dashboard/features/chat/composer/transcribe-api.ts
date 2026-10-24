/**
 * Client for `POST /api/coder/transcribe` — turns a recorded audio blob into
 * text for the composer mic button. The base64 conversion lives in
 * `../utils.ts` (`readDataUrlBase64`), shared with file attachments.
 */

type TranscribeErrorCode = 'no-model' | 'http' | 'empty';

export class TranscribeError extends Error {
  constructor(readonly code: TranscribeErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TranscribeError';
  }
}

/**
 * POST a recording and return the transcript. Throws `TranscribeError` with a
 * `code` the caller maps to a localized toast:
 *   - `no-model` (HTTP 412): no transcription model configured in Pipelines.
 *   - `http`: any other non-2xx response.
 *   - `empty`: the model returned no text (e.g. silence).
 */
export async function transcribeAudio(
  base64: string,
  mediaType: string,
  language?: string,
): Promise<string> {
  const res = await fetch('/api/coder/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base64, mediaType, language }),
  });
  if (res.status === 412) throw new TranscribeError('no-model');
  if (!res.ok) throw new TranscribeError('http', `HTTP ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  const text = (data.text ?? '').trim();
  if (!text) throw new TranscribeError('empty');
  return text;
}

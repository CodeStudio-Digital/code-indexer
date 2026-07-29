/**
 * Wire-contract tests for api-enhance: the exact POST bodies of the inpaint /
 * enhance starters and the module-level job-start notification AiEditBar
 * relies on (EditModeView's frozen prop chain can't carry the job ref — see
 * the api-enhance docblock).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blobToBase64,
  onEnhanceJobStarted,
  startEnhanceJob,
  startInpaintJob,
  type EnhanceJobRef,
} from '../api-enhance.js';

// Node env: apiBaseUrl() returns '' (no window) — URLs are origin-relative.
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
const JOB_ID = '00000000-0000-4000-8000-000000000007';
const JOB_ID_2 = '00000000-0000-4000-8000-000000000009';
const ASSET_ID = '00000000-0000-4000-8000-000000000011';
const ASSET_ID_2 = '00000000-0000-4000-8000-000000000002';
const VERSION_ID = '00000000-0000-4000-8000-000000000042';
const VERSION_ID_2 = '00000000-0000-4000-8000-000000000008';

function stubFetch(status = 200, payload: unknown = { jobId: JOB_ID }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('blobToBase64', () => {
  it('round-trips bytes to raw base64 (no data: prefix)', async () => {
    const bytes = new Uint8Array([0, 1, 2, 128, 250, 255]);
    const b64 = await blobToBase64(new Blob([bytes], { type: 'image/png' }));
    expect(b64).not.toMatch(/^data:/);
    expect(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))).toEqual(bytes);
  });
});

describe('startInpaintJob', () => {
  it('POSTs the edit contract body and notifies listeners', async () => {
    stubFetch();
    const seen: EnhanceJobRef[] = [];
    const off = onEnhanceJobStarted((ref) => seen.push(ref));
    try {
      const mask = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      const ref = await startInpaintJob(3, ASSET_ID, VERSION_ID, mask, 'troque a espada por um machado');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('/api/sprite-studio/projects/3/generate');
      expect(calls[0].body).toEqual({
        kind: 'inpaint',
        prompt: 'troque a espada por um machado',
        n: 2,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        maskBase64: await blobToBase64(mask),
        rawPrompt: true,
      });
      expect(ref).toEqual({
        jobId: JOB_ID,
        projectId: 3,
        assetId: ASSET_ID,
        versionId: VERSION_ID,
        kind: 'inpaint',
      });
      expect(seen).toEqual([ref]);
    } finally {
      off();
    }
  });
});

describe('startEnhanceJob', () => {
  it('POSTs a maskless enhance body with the chosen n', async () => {
    stubFetch(200, { jobId: JOB_ID_2 });
    const ref = await startEnhanceJob(5, ASSET_ID_2, VERSION_ID_2, 'mais contraste, roupa medieval', 4);
    expect(calls[0].url).toBe('/api/sprite-studio/projects/5/generate');
    expect(calls[0].body).toEqual({
      kind: 'enhance', prompt: 'mais contraste, roupa medieval', n: 4,
      assetId: ASSET_ID_2, versionId: VERSION_ID_2, rawPrompt: true,
    });
    expect(calls[0].body).not.toHaveProperty('maskBase64');
    expect(ref).toEqual({
      jobId: JOB_ID_2,
      projectId: 5,
      assetId: ASSET_ID_2,
      versionId: VERSION_ID_2,
      kind: 'enhance',
    });
  });

  it('surfaces the backend error and does NOT notify listeners', async () => {
    stubFetch(404, { error: 'not_found' });
    const seen: EnhanceJobRef[] = [];
    const off = onEnhanceJobStarted((ref) => seen.push(ref));
    try {
      await expect(startEnhanceJob(5, ASSET_ID_2, VERSION_ID_2, 'p')).rejects.toThrow('not_found');
      expect(seen).toEqual([]);
    } finally {
      off();
    }
  });

  it('stops notifying after unsubscribe', async () => {
    stubFetch();
    const seen: EnhanceJobRef[] = [];
    const off = onEnhanceJobStarted((ref) => seen.push(ref));
    off();
    await startEnhanceJob(1, ASSET_ID, VERSION_ID, 'p');
    expect(seen).toEqual([]);
  });
});

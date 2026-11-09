import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDocBody } from '../docs/useCompanyDocs.js';
import { describeEnvApplication, readEnvMutation } from '../env-application.js';

afterEach(() => vi.unstubAllGlobals());
describe('knowledge and environment UI request contracts', () => {
  it('surfaces unavailable docs rather than an empty document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    await expect(fetchDocBody('session', null, 'adr.md')).rejects.toThrow('HTTP 503');
  });
  it('requests the selected service and preserves durable provenance', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ content: 'decision', origin: 'drive_mirror', mtime: 'today' })));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchDocBody('session', 'api', 'auth/adr.md')).toMatchObject({ content: 'decision', origin: 'drive_mirror' });
    expect(fetch.mock.calls[0]?.[0]).toContain('service=api');
  });
  it('does not treat an HTTP env mutation error as successful save', async () => {
    await expect(readEnvMutation(new Response(JSON.stringify({ error: 'locked' }), { status: 409 }))).rejects.toThrow('locked');
  });
  it('distinguishes persisted from partially applied environments', async () => {
    const result = await readEnvMutation(new Response(JSON.stringify({ persisted: true, application: { state: 'partial', applied: ['api'], failed: [{ serviceId: 'worker', reason: 'environment_write_failed' }], restartRequired: true } })));
    const message = describeEnvApplication(result);
    expect(message).toContain('api'); expect(message).toContain('worker'); expect(message).toContain('Reinicie');
  });
});

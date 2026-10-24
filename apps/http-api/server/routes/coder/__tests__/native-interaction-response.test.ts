import { expect, it, vi } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import { resolveNativeInteraction } from '../native-interaction-response.js';

function fixture(generation?: 'rust_v1' | 'legacy_ts', persisted = false) {
  const pool = { getRuntimeHandle: vi.fn(() => generation ? { runtimeGeneration: generation } : null), provideUserInput: vi.fn(async () => true) };
  const sessions = { loadSessionMessagesTail: vi.fn(async () => persisted ? { runtime_outcome: { runtimeGeneration: 'rust_v1' } } : null) };
  const input = { pool, sessions, sessionId: asSessionId('11111111-1111-4111-8111-111111111111'),
    interactionId: 'native-tool:review', prefix: 'native-tool:', value: '{"approved":true}' };
  return { pool, sessions, input: input as unknown as Parameters<typeof resolveNativeInteraction>[0] };
}
it('uses the native facade with the exact displayed identity', async () => {
  const f = fixture('rust_v1'); expect(await resolveNativeInteraction(f.input)).toEqual({ status: 200, body: { ok: true } });
  expect(f.pool.provideUserInput).toHaveBeenCalledWith(f.input.sessionId, f.input.value, 'native-tool:review');
  expect(f.sessions.loadSessionMessagesTail).not.toHaveBeenCalled();
});
it('requires identity and never falls back after lost acknowledgement or missing owner', async () => {
  const f = fixture('rust_v1');
  expect((await resolveNativeInteraction({ ...f.input, interactionId: undefined }))?.status).toBe(400);
  expect(f.pool.provideUserInput).not.toHaveBeenCalled();
  f.pool.provideUserInput.mockRejectedValueOnce(new Error('ACK lost'));
  expect(await resolveNativeInteraction(f.input)).toMatchObject({ status: 503, body: { code: 'INTERACTION_DELIVERY_UNCONFIRMED' } });
  const reopened = fixture(undefined, true);
  expect(await resolveNativeInteraction(reopened.input)).toMatchObject({ status: 409, body: { code: 'NATIVE_INTERACTION_RECOVERY_REQUIRED' } });
  expect(reopened.pool.provideUserInput).not.toHaveBeenCalled();
});
it('leaves existing legacy response and recovery handling compatible', async () => {
  expect(await resolveNativeInteraction(fixture('legacy_ts').input)).toBeUndefined();
  expect(await resolveNativeInteraction(fixture().input)).toBeUndefined();
});

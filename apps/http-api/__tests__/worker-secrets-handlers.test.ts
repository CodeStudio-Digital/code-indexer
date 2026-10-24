import { afterEach, expect, it, vi } from 'vitest';
import { registerWorkerSecretsHandlers } from '../sse/worker-secrets-handlers.js';
import { setMainSecretDecryptor, setMainSecretEncryptor } from '../server/secret-decrypt-port.js';

afterEach(() => { setMainSecretDecryptor(null); setMainSecretEncryptor(null); });
function handlers(assertOwner: (runId: unknown) => () => void) {
  const entries = new Map<string, (payload: unknown) => Promise<unknown>>();
  const dispose = registerWorkerSecretsHandlers({ handle(name, fn) {
    entries.set(name, fn); return () => { entries.delete(name); };
  } }, assertOwner);
  return { entries, dispose };
}
it('rejects a stale attempt before accessing its saved credential', async () => {
  const decrypt = vi.fn(() => 'fixture-secret'); setMainSecretDecryptor(decrypt);
  const { entries, dispose } = handlers(runId => {
    if (runId !== 'active') throw new Error('stale attempt'); return () => {};
  });
  await expect(entries.get('secretsDecrypt')!({ runId: 'old', blob: 'fixture-blob' })).rejects.toThrow('stale');
  expect(decrypt).not.toHaveBeenCalled(); dispose(); expect(entries.size).toBe(0);
});
it.each(['secretsDecrypt', 'secretsEncrypt'])('withholds %s reply if authority is revoked while pending', async name => {
  let release!: (value: string) => void, revoked = false;
  const pending = new Promise<string>(resolve => { release = resolve; });
  setMainSecretDecryptor(() => pending); setMainSecretEncryptor(() => pending);
  const { entries, dispose } = handlers(() => () => { if (revoked) throw new Error('authority revoked'); });
  const result = entries.get(name)!({ runId: 'active', blob: 'fixture-blob', plaintext: 'fixture-plaintext' });
  revoked = true; release('fixture-result');
  await expect(result).rejects.toThrow('authority revoked'); dispose();
});

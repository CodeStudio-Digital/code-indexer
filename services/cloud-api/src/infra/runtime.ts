/** Kernel-port adapters backed by the workerd runtime (Date / WebCrypto). */
import type { Clock, IdGen } from '@cloudstudio/cloud-kernel';

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export const cryptoIdGen: IdGen = {
  uuid: () => crypto.randomUUID(),
  slug: (size = 22) => {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < size; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
    return out;
  },
};


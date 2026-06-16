/** Kernel-port adapters backed by the workerd runtime (Date / WebCrypto / console). */
import type { Clock, IdGen, Logger, RandomSource } from '@cloudstudio/cloud-kernel';

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

export const webCryptoRandom: RandomSource = {
  bytes: (n: number) => {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  },
};

export const consoleLogger: Logger = {
  info: (m, f) => console.log(JSON.stringify({ level: 'info', m, ...f })),
  warn: (m, f) => console.warn(JSON.stringify({ level: 'warn', m, ...f })),
  error: (m, f) => console.error(JSON.stringify({ level: 'error', m, ...f })),
};

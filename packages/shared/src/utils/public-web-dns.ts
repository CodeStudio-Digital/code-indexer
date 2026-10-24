import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateHost } from './ssrf.js';

/** Resolve once, reject mixed public/private answers, and pin the selected
 * address at the socket. A cancelled resolver has no surviving DNS queries. */
export async function resolvePublicWebHost(hostname: string, signal: AbortSignal): Promise<{ address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw new Error(`refusing private/loopback host '${hostname}'`);
  const family = isIP(host);
  if (family) return { address: host, family: family as 4 | 6 };
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  const abort = () => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    signal.throwIfAborted();
    const addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (!addresses.length) throw new Error(`No public DNS address for '${hostname}'`);
    if (addresses.some(address => !isIP(address) || isPrivateHost(address))) throw new Error(`refusing private or mixed DNS answers for '${hostname}'`);
    return { address: addresses[0], family: isIP(addresses[0]) as 4 | 6 };
  } finally { signal.removeEventListener('abort', abort); resolver.cancel(); }
}

/** LoginThrottle port adapter over the LoginThrottleDO Durable Object. Each key
 *  maps to one DO instance (`idFromName`), giving serialized per-key counters. */
import type { LoginThrottle } from '@cloudstudio/cloud-identity';

export function createLoginThrottle(ns: DurableObjectNamespace): LoginThrottle {
  const call = (key: string, path: string): Promise<Response> =>
    ns.get(ns.idFromName(key)).fetch(`https://throttle.internal${path}`);

  return {
    async check(key) {
      const res = await call(key, '/check');
      return (await res.json()) as { locked: boolean; retryAfterMs: number };
    },
    async recordFailure(key) {
      await call(key, '/fail');
    },
    async recordSuccess(key) {
      await call(key, '/success');
    },
  };
}

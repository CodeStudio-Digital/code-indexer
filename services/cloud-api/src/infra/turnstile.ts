/** BotVerifier over Cloudflare Turnstile siteverify. `enabled` is false without a
 *  secret (local dev / unprovisioned), which disables the anonymous submit path. */
import type { BotVerifier } from '@cloudstudio/cloud-feedback';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createBotVerifier(secret: string | undefined): BotVerifier {
  return {
    enabled: !!secret,
    async verify(token: string, ip: string | null) {
      if (!secret) return false;
      const form = new URLSearchParams({ secret, response: token });
      if (ip) form.set('remoteip', ip);
      const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
      if (!res.ok) return false;
      const data = (await res.json()) as { success?: boolean };
      return data.success === true;
    },
  };
}

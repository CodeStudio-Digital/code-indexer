/**
 * Cloudflare Turnstile for the portal's bot-exposed forms (login / signup). The
 * site key is PUBLIC (set at build via VITE_TURNSTILE_SITEKEY). When unset the
 * widget is a no-op and forms behave as before — matching the Worker, which only
 * enforces Turnstile once TURNSTILE_SECRET is set (provision both together).
 * Renders the challenge and reports the single-use token via onToken; bump
 * resetNonce after a submit to mint a fresh one.
 */
import { useEffect, useRef } from 'react';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const TURNSTILE_SITE_KEY: string = env.VITE_TURNSTILE_SITEKEY ?? '';
export const turnstileEnabled: boolean = TURNSTILE_SITE_KEY.length > 0;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
const api = (): TurnstileApi | null => (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null;

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => resolve(); // fail-soft: the form gates submit on a present token
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function TurnstileWidget({ onToken, resetNonce = 0 }: { onToken: (token: string | null) => void; resetNonce?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    if (!turnstileEnabled) return;
    let cancelled = false;
    void loadScript().then(() => {
      const tryRender = () => {
        if (cancelled || !ref.current || idRef.current) return;
        const t = api();
        if (!t) {
          window.setTimeout(tryRender, 120);
          return;
        }
        idRef.current = t.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        });
      };
      tryRender();
    });
    return () => {
      cancelled = true;
      const t = api();
      if (t && idRef.current) {
        try {
          t.remove(idRef.current);
        } catch {
          /* widget already gone */
        }
        idRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!turnstileEnabled || resetNonce === 0) return;
    const t = api();
    if (t && idRef.current) {
      try {
        t.reset(idRef.current);
      } catch {
        /* ignore */
      }
      onToken(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetNonce]);

  if (!turnstileEnabled) return null;
  return <div ref={ref} className="min-h-[65px]" />;
}

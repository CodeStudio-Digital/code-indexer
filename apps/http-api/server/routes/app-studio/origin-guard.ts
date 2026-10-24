/**
 * Guard de origem para as rotas do App Studio. A API monta CORS
 * `origin: '*'` globalmente (server.ts) — ok para GETs de leitura do
 * dashboard, mas PERIGOSO aqui: `POST /launch` cria recursos na conta
 * Cloudflare do usuário e `GET /data` lê o banco local do app. Sem este
 * guard, qualquer site que o usuário visite poderia disparar um deploy ou
 * exfiltrar dados via `fetch` cross-origin (o browser sempre manda o
 * header `Origin` em requisições cross-origin de `fetch`).
 *
 * Política: só passa quando NÃO há Origin (GET same-origin / cliente
 * nativo) OU o Origin é local (localhost/127.0.0.1/[::1]) OU um esquema
 * de app nativo (mcp://, file://, app://) — o dashboard em dev
 * (vite proxy), em produção (Electron) e o próprio servidor. Qualquer
 * Origin http(s) remoto é bloqueado com 403.
 */
import type { Context, Next } from 'hono';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLocalOrigin(origin: string | undefined | null): boolean {
  if (!origin || origin === 'null') return true; // same-origin GET, native fetch, opaque
  try {
    const url = new URL(origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return LOCAL_HOSTS.has(url.hostname);
    }
    // mcp://app, file://, app:// — superfícies nativas do Electron.
    return true;
  } catch {
    return false; // Origin malformado → rejeita
  }
}

export async function requireLocalOrigin(c: Context, next: Next): Promise<Response | void> {
  if (!isLocalOrigin(c.req.header('origin'))) {
    return c.json(
      { error: 'Cross-origin requests are not allowed for App Studio (local-only feature).' },
      403,
    );
  }
  await next();
}

/**
 * Client das rotas de publicação (login OAuth + launch chain), com o
 * consumidor SSE compartilhado (POST → frames event/data, EventSource não
 * faz POST).
 */

export interface CfWhoami {
  logged_in: boolean;
  email: string | null;
  accounts: Array<{ name: string; id: string }>;
}

export type LaunchPhaseId = 'auth' | 'db' | 'migrate' | 'build' | 'deploy' | 'health' | 'persist';

async function consumeSse(
  r: Response,
  onFrame: (event: string, data: unknown) => void,
): Promise<void> {
  if (!r.ok || !r.body) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON */
    }
    throw new Error(`${r.status}: ${msg}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) onFrame(event, JSON.parse(dataLines.join('\n')));
    }
  }
}

export async function getCfWhoami(sessionId: string): Promise<CfWhoami> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/publish`);
  if (!r.ok) throw new Error(r.statusText);
  return (await r.json()) as CfWhoami;
}

/** wrangler login (OAuth no browser). Resolve com o whoami confirmado. */
export async function streamCfLogin(
  sessionId: string,
  handlers: { onOauthUrl?: (url: string) => void; onLog?: (chunk: string) => void } = {},
): Promise<CfWhoami> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/publish/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  let result: CfWhoami | null = null;
  let error: string | null = null;
  await consumeSse(r, (event, data) => {
    if (event === 'oauth-url') handlers.onOauthUrl?.((data as { url: string }).url);
    else if (event === 'log') handlers.onLog?.((data as { chunk: string }).chunk);
    else if (event === 'done') result = data as CfWhoami;
    else if (event === 'error') error = (data as { message: string }).message;
  });
  if (error) throw new Error(error);
  if (!result) throw new Error('Login stream ended without a result.');
  return result;
}

export interface LaunchResult {
  url: string | null;
  health_ok: boolean;
  account?: string | null;
}

/** A launch chain completa. Lança em erro/auth-required (message distinta). */
export async function streamAppLaunch(
  sessionId: string,
  handlers: { onPhase?: (phase: LaunchPhaseId) => void; onLog?: (chunk: string) => void } = {},
): Promise<LaunchResult> {
  const r = await fetch(`/api/app-studio/apps/${sessionId}/publish`, { method: 'POST' });
  let result: LaunchResult | null = null;
  let error: string | null = null;
  let authRequired = false;
  await consumeSse(r, (event, data) => {
    if (event === 'phase') handlers.onPhase?.((data as { phase: LaunchPhaseId }).phase);
    else if (event === 'log') handlers.onLog?.((data as { chunk: string }).chunk);
    else if (event === 'auth-required') authRequired = true;
    else if (event === 'done') result = (data as { deploy: LaunchResult }).deploy;
    else if (event === 'error') error = (data as { message: string }).message;
  });
  if (authRequired) throw new Error('auth-required');
  if (error) throw new Error(error);
  if (!result) throw new Error('Launch stream ended without a result.');
  return result;
}

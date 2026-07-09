/**
 * Conexão Cloudflare do leigo — `wrangler login` (OAuth no browser) com
 * eventos SSE, + whoami parseado para o card de conexão.
 *
 * Sem PTY: o wrangler imprime a URL OAuth, abre o browser sozinho e espera
 * o callback em localhost:8976 — nenhum input via terminal. A UI recebe a
 * URL como evento (clique manual quando o browser não abrir). Sucesso é
 * CONFIRMADO por `wrangler whoami`, nunca só pela frase do login.
 *
 * cwd preferencial = workspace do app (usa o wrangler pinado em
 * node_modules); fallback homedir (npx resolve).
 */
import { homedir } from 'node:os';
import { runHostCommand } from '@mcp/services/host-scaffold/run-host-command.js';

const LOGIN_TIMEOUT_MS = 300_000;
const WHOAMI_TIMEOUT_MS = 60_000;
const OAUTH_URL_RE = /https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/;

export interface CfAccountInfo {
  name: string;
  id: string;
}

export interface CfWhoami {
  logged_in: boolean;
  email: string | null;
  accounts: CfAccountInfo[];
}

async function wrangler(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderrTail: string }> {
  let stdout = '';
  const result = await runHostCommand({
    program: 'npx',
    args: ['wrangler', ...args],
    cwd,
    timeoutMs,
    signal,
    onLog: (stream, chunk) => {
      if (stream === 'stdout') stdout += chunk;
      onLog?.(stream, chunk);
    },
  });
  return { ok: result.ok, exitCode: result.exitCode, stdout, stderrTail: result.stderrTail };
}

/** Parse tolerante do `wrangler whoami` (texto muda entre versões). */
export async function runWranglerWhoami(cwd?: string | null): Promise<CfWhoami> {
  const run = await wrangler(['whoami'], cwd ?? homedir(), WHOAMI_TIMEOUT_MS);
  const text = run.stdout + run.stderrTail;
  if (!run.ok || /not authenticated|not logged in/i.test(text)) {
    return { logged_in: false, email: null, accounts: [] };
  }
  // Trailing `.` fora: o wrangler encerra a frase com ponto ("…email x@y.com.").
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0].replace(/\.+$/, '') ?? null;
  // Linhas de tabela "│ Nome da conta │ 0748c7… │" (32 hex = account id).
  const accounts: CfAccountInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/[│|]\s*(.+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]/);
    if (match) accounts.push({ name: match[1].trim(), id: match[2] });
  }
  return { logged_in: true, email, accounts };
}

export type AppCfLoginEvent =
  | { event: 'oauth-url'; data: { url: string } }
  | { event: 'log'; data: { stream: 'stdout' | 'stderr'; chunk: string } }
  | { event: 'done'; data: CfWhoami }
  | { event: 'error'; data: { message: string } };

/**
 * `wrangler login` streamado. Timeout 300s (o usuário precisa clicar
 * Allow no browser); abort mata o child.
 */
export async function runWranglerLoginStream(
  emit: (ev: AppCfLoginEvent) => void,
  opts: { cwd?: string | null; signal?: AbortSignal } = {},
): Promise<void> {
  const cwd = opts.cwd ?? homedir();

  // Já logado? Não abre browser à toa.
  const already = await runWranglerWhoami(cwd);
  if (already.logged_in) {
    emit({ event: 'done', data: already });
    return;
  }

  let urlEmitted = false;
  const scanForUrl = (chunk: string): void => {
    if (urlEmitted) return;
    const match = chunk.match(OAUTH_URL_RE);
    if (match) {
      urlEmitted = true;
      emit({ event: 'oauth-url', data: { url: match[0] } });
    }
  };

  const login = await wrangler(
    ['login'],
    cwd,
    LOGIN_TIMEOUT_MS,
    (stream, chunk) => {
      scanForUrl(chunk);
      emit({ event: 'log', data: { stream, chunk } });
    },
    opts.signal,
  );
  if (!login.ok) {
    emit({
      event: 'error',
      data: { message: `wrangler login failed (exit ${login.exitCode}): ${login.stderrTail.slice(-400)}` },
    });
    return;
  }

  // Sucesso confirmado por whoami — nunca só pela frase do login.
  const who = await runWranglerWhoami(cwd);
  if (!who.logged_in) {
    emit({ event: 'error', data: { message: 'Login finished but wrangler whoami still reports logged out.' } });
    return;
  }
  emit({ event: 'done', data: who });
}

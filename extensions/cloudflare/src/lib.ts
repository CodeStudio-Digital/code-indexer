/**
 * Cloudflare plugin helpers, shared by the tools. Honors the locked auth
 * decision ("os dois"): a pasted API token (stored per-plugin via ctx.storage)
 * enables the REST API; everything also works through `npx wrangler` (which
 * reads CLOUDFLARE_API_TOKEN from the env we pass). REST is preferred for
 * reads when a token exists; wrangler is the backbone for deploy/auth.
 */
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';

const API = 'https://api.cloudflare.com/client/v4';

export interface CfDetect {
  isCloudflare: boolean;
  configPath: string | null;
  workerName: string | null;
  packageName: string | null;
}

/** The pasted API token, or null. */
export async function getToken(ctx: PluginToolContext): Promise<string | null> {
  return ctx.storage ? ctx.storage.get('apiToken') : null;
}

/** The selected account id (set after whoami picks one), or null. */
export async function getAccountId(ctx: PluginToolContext): Promise<string | null> {
  return ctx.storage ? ctx.storage.get('accountId') : null;
}

/** Authenticated REST call. Throws if no token or the API returns errors. */
export async function cfFetch<T = unknown>(
  ctx: PluginToolContext,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = await getToken(ctx);
  if (!token) throw new Error('no Cloudflare API token set (paste one in the panel)');
  const res = await ctx.fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: T;
    errors?: Array<{ message: string }>;
  };
  if (!res.ok || body.success === false) {
    const msg = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${msg}`);
  }
  return body.result as T;
}

/** Run a wrangler subcommand one-shot, with the token injected into env. */
export async function wrangler(
  ctx: PluginToolContext,
  args: string[],
): Promise<{ stdout: string; code: number | null }> {
  if (!ctx.exec) throw new Error('exec capability not granted');
  const token = await getToken(ctx);
  const accountId = await getAccountId(ctx);
  const env: Record<string, string> = {};
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return ctx.exec.run('npx', ['wrangler', ...args], { cwd: ctx.cwd, env });
}

/** Read the wrangler config name field (toml or jsonc) without a full parser. */
function parseConfigName(text: string): string | null {
  // jsonc: "name": "x"   |   toml: name = "x"
  const m =
    text.match(/"name"\s*:\s*"([^"]+)"/) ?? text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/** Detect whether the project is a Cloudflare Worker/Pages project via ctx.fs. */
export async function detectCloudflare(ctx: PluginToolContext): Promise<CfDetect> {
  const out: CfDetect = {
    isCloudflare: false,
    configPath: null,
    workerName: null,
    packageName: null,
  };
  if (!ctx.fs) return out;
  for (const cfg of ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) {
    if (await ctx.fs.exists(cfg)) {
      out.isCloudflare = true;
      out.configPath = cfg;
      try {
        out.workerName = parseConfigName(await ctx.fs.readFile(cfg));
      } catch {
        /* unreadable — leave name null */
      }
      break;
    }
  }
  if (await ctx.fs.exists('package.json')) {
    try {
      const pkg = JSON.parse(await ctx.fs.readFile('package.json')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      out.packageName = pkg.name ?? null;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.wrangler || deps['@cloudflare/workers-types']) out.isCloudflare = true;
    } catch {
      /* ignore malformed package.json */
    }
  }
  return out;
}

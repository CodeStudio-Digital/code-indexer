import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';

const MAX_BYTES = 400_000;
const MAX_REDIRECTS = 3;
const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Public http(s) URL for an optional UX reference.' },
  },
  required: ['url'],
  additionalProperties: false,
};

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) return privateIpv4(value.slice(7));
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
    || /^fe[89ab]/.test(value) || value.startsWith('ff');
}

async function assertPublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only public http(s) references are allowed.');
  if (url.username || url.password) throw new Error('Credentials in reference URLs are not allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Local reference addresses are blocked.');
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => privateAddress(item.address))) throw new Error('Private, loopback, link-local, and reserved addresses are blocked.');
  return url;
}

async function fetchReference(input: string): Promise<{ url: string; contentType: string; text: string }> {
  let url = await assertPublicUrl(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { Accept: 'text/html,text/plain,text/css,application/json;q=0.8' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) throw new Error('Reference redirected too many times.');
      url = await assertPublicUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Reference returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!['text/html', 'text/plain', 'text/css', 'application/json'].includes(contentType)) throw new Error(`Unsupported reference content type '${contentType || 'unknown'}'.`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) throw new Error('Reference content is too large.');
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_BYTES) throw new Error('Reference content is too large.');
    return { url: url.toString(), contentType, text: new TextDecoder().decode(body) };
  }
  throw new Error('Unable to read reference.');
}

export const appFetchUxReference: CoderTool = {
  name: 'app_fetch_ux_reference',
  description: 'Read a small public UX reference URL. Local/private addresses, unsafe redirects, binary content, and oversized responses are blocked.',
  parameters: PARAMETERS,
  source: 'native',
  handler: async (args) => {
    try { return ok(JSON.stringify(await fetchReference(String(args.url ?? '')), null, 2)); }
    catch (error) { return err(`app_fetch_ux_reference failed: ${(error as Error).message}`); }
  },
};


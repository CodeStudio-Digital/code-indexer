/**
 * parseCurl — turn a curl/bash command into a request shape the store can save.
 * Recognizes the common flags; unknown flags are skipped (never throws except on
 * empty input / no URL). Method + body-kind are inferred from the flags used.
 */
import { tokenizeShell } from './tokenize.js';

export interface CurlAuth { type: 'basic'; username: string; password: string; }
export interface CurlField { name: string; value: string; filename?: string; }
export type CurlBody =
  | { kind: 'none' }
  | { kind: 'json' | 'raw'; content: string; contentType?: string }
  | { kind: 'urlencoded'; fields: CurlField[] }
  | { kind: 'form-data'; fields: CurlField[] };

export interface CurlParseResult {
  method: string;
  url: string;
  path_template: string;
  query: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  body: CurlBody;
  auth?: CurlAuth;
  name: string;
}

const NEEDS_ARG = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-ascii', '--data-binary', '--data-urlencode', '-F', '--form', '-u', '--user', '--url', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer']);
const NO_ARG = new Set(['-G', '--get', '--compressed', '-k', '--insecure', '-L', '--location', '-s', '--silent', '-i', '--include', '-v', '--verbose']);

export function parseCurl(text: string): CurlParseResult {
  if (!text || !text.trim()) throw new Error('empty curl command');
  const toks = tokenizeShell(text).filter((t) => t && t !== 'curl' && t !== 'curl.exe');

  let method = '';
  let url = '';
  const headers: Array<{ key: string; value: string }> = [];
  const dataParts: string[] = [];
  const urlencodeParts: CurlField[] = [];
  const formParts: CurlField[] = [];
  let auth: CurlAuth | undefined;
  let forceGet = false;
  let dataBinary = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const arg = (): string => toks[++i] ?? '';
    if (t === '-X' || t === '--request') method = arg().toUpperCase();
    else if (t === '-H' || t === '--header') addHeader(headers, arg());
    else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-ascii') dataParts.push(arg());
    else if (t === '--data-binary') { dataParts.push(arg()); dataBinary = true; }
    else if (t === '--data-urlencode') urlencodeParts.push(splitField(arg()));
    else if (t === '-F' || t === '--form') formParts.push(splitFormField(arg()));
    else if (t === '-u' || t === '--user') { const [u, p = ''] = arg().split(/:(.*)/s); auth = { type: 'basic', username: u, password: p }; }
    else if (t === '-b' || t === '--cookie') addHeader(headers, `Cookie: ${arg()}`);
    else if (t === '-A' || t === '--user-agent') addHeader(headers, `User-Agent: ${arg()}`);
    else if (t === '-e' || t === '--referer') addHeader(headers, `Referer: ${arg()}`);
    else if (t === '--url') url = arg();
    else if (t === '-G' || t === '--get') forceGet = true;
    else if (NO_ARG.has(t)) { /* ignore */ }
    else if (t.startsWith('--') && t.includes('=')) { /* ignore unknown --flag=val */ }
    else if (t.startsWith('-') && t.length > 1) { if (NEEDS_ARG.has(t)) i++; /* skip unknown flag's arg */ }
    else if (!url) url = t; // positional URL
  }

  if (!url) throw new Error('no URL found in curl command');

  const hasData = dataParts.length || urlencodeParts.length;
  const hasForm = formParts.length > 0;
  if (!method) method = forceGet ? 'GET' : (hasData || hasForm ? 'POST' : 'GET');

  const body = buildBody(dataParts, urlencodeParts, formParts, headers, dataBinary);
  const { path_template, query } = splitUrl(url);
  return { method, url, path_template, query, headers, body, auth, name: deriveName(url) };
}

function addHeader(out: Array<{ key: string; value: string }>, raw: string): void {
  const idx = raw.indexOf(':');
  if (idx <= 0) return;
  out.push({ key: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() });
}

function splitField(raw: string): CurlField {
  const idx = raw.indexOf('=');
  return idx < 0 ? { name: raw, value: '' } : { name: raw.slice(0, idx), value: raw.slice(idx + 1) };
}

function splitFormField(raw: string): CurlField {
  const idx = raw.indexOf('=');
  if (idx < 0) return { name: raw, value: '' };
  const name = raw.slice(0, idx);
  const val = raw.slice(idx + 1);
  if (val.startsWith('@')) return { name, value: '', filename: val.slice(1) };
  return { name, value: val };
}

function buildBody(data: string[], urlenc: CurlField[], form: CurlField[], headers: Array<{ key: string; value: string }>, binary: boolean): CurlBody {
  if (form.length) return { kind: 'form-data', fields: form };
  if (urlenc.length) return { kind: 'urlencoded', fields: urlenc };
  if (!data.length) return { kind: 'none' };
  const content = data.join('&');
  const ct = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const looksJson = /json/i.test(ct) || /^\s*[[{]/.test(content);
  if (looksJson && !binary) return { kind: 'json', content };
  if (/x-www-form-urlencoded/i.test(ct)) return { kind: 'urlencoded', fields: content.split('&').map(splitField) };
  return { kind: 'raw', content, contentType: ct || undefined };
}

function splitUrl(url: string): { path_template: string; query: Array<{ key: string; value: string }> } {
  const q = url.indexOf('?');
  if (q < 0) return { path_template: url, query: [] };
  const path = url.slice(0, q);
  const query = url.slice(q + 1).split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    return eq < 0 ? { key: decode(pair), value: '' } : { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)) };
  });
  return { path_template: path, query };
}

function decode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return `${seg || u.hostname}`;
  } catch {
    const seg = url.replace(/\?.*$/, '').split('/').filter(Boolean).pop();
    return seg || 'Imported request';
  }
}

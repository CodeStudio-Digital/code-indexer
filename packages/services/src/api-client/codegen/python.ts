/**
 * Python generator — requests.request(...).
 */
import type { CodegenRequest } from './types.js';

export function generatePython(req: CodegenRequest): string {
  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.name] = h.value;

  const lines = ['import requests', ''];
  if (Object.keys(headers).length) lines.push(`headers = ${py(headers)}`);

  const b = req.body;
  let bodyArg = '';
  if (b.kind === 'json') { lines.push(`data = ${pyStr(b.content)}`); bodyArg = ', data=data'; }
  else if (b.kind === 'raw') { lines.push(`data = ${pyStr(b.content)}`); bodyArg = ', data=data'; }
  else if (b.kind === 'graphql') { lines.push(`json_body = ${py({ query: b.query, variables: safeParse(b.variables) })}`); bodyArg = ', json=json_body'; }
  else if (b.kind === 'urlencoded') { lines.push(`data = ${py(Object.fromEntries(b.fields))}`); bodyArg = ', data=data'; }
  else if (b.kind === 'form-data') {
    const files = b.fields.filter((f) => f.filename);
    const fields = b.fields.filter((f) => !f.filename);
    if (fields.length) lines.push(`data = ${py(Object.fromEntries(fields.map((f) => [f.name, f.value])))}`);
    if (files.length) lines.push(`files = ${py(Object.fromEntries(files.map((f) => [f.name, `open('${f.filename}','rb')`])))}`);
    bodyArg = `${fields.length ? ', data=data' : ''}${files.length ? ', files=files' : ''}`;
  } else if (b.kind === 'binary') { lines.push(`data = open(${pyStr(b.note)}, 'rb')`); bodyArg = ', data=data'; }

  const headersArg = Object.keys(headers).length ? ', headers=headers' : '';
  lines.push(`response = requests.request(${pyStr(req.method)}, ${pyStr(req.url)}${headersArg}${bodyArg})`);
  lines.push('print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

function pyStr(s: string): string { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`; }
function py(v: unknown): string { return JSON.stringify(v, null, 4); }
function safeParse(s?: string): unknown { if (!s) return undefined; try { return JSON.parse(s); } catch { return s; } }

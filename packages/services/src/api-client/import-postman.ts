import type { ApiBodyRawLang, CreateRequestInput } from '@mcp/store/api-client-types.js';

type Obj = Record<string, unknown>;
type RequestInput = Omit<CreateRequestInput, 'collection_id'>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const description = (v: unknown) => str(v) || str(obj(v).content);

function rows(v: unknown) {
  return array(v).map(obj).filter(r => typeof r.key === 'string').map(r => ({
    key: str(r.key), value: str(r.value), enabled: r.disabled !== true, description: description(r.description),
  }));
}

function mapAuth(input: unknown): Partial<RequestInput> | undefined {
  const auth = obj(input);
  const type = auth.type;
  if (type == null || type === 'noauth') return {};
  if (type !== 'basic' && type !== 'bearer' && type !== 'apikey') return undefined;
  const fields = Object.fromEntries(rows(auth[type]).filter(r => r.enabled).map(r => [r.key, r.value]));
  return { auth_type: type, auth_json: JSON.stringify(fields) };
}

function mapBody(input: unknown): Partial<RequestInput> | undefined {
  const body = obj(input);
  if (!body.mode || body.disabled) return {};
  if (body.mode === 'raw') {
    const language = str(obj(obj(body.options).raw).language);
    const lang = ['json','xml','html','javascript'].includes(language) ? language as ApiBodyRawLang : 'text';
    return { body_kind: lang === 'json' ? 'json' : 'raw', body_raw_lang: lang, body_json: str(body.raw) };
  }
  if (body.mode === 'urlencoded') return { body_kind: 'urlencoded', body_urlencoded_json: JSON.stringify(rows(body.urlencoded)) };
  if (body.mode === 'formdata' && array(body.formdata).every(r => obj(r).type !== 'file')) {
    return { body_kind: 'form-data', body_form_json: JSON.stringify(rows(body.formdata)) };
  }
  if (body.mode === 'graphql') {
    const gql = obj(body.graphql);
    return { body_kind: 'graphql', body_graphql_json: JSON.stringify({ query: str(gql.query), variables: str(gql.variables) || JSON.stringify(gql.variables ?? {}) }) };
  }
  return undefined;
}

function mapUrl(input: unknown): Pick<RequestInput, 'path_template' | 'query_json'> | undefined {
  const url = obj(input);
  let raw = str(input) || str(url.raw);
  if (!raw && url.host) {
    const host = Array.isArray(url.host) ? url.host.join('.') : str(url.host);
    const path = Array.isArray(url.path) ? url.path.map(p => str(p) || str(obj(p).value)).join('/') : str(url.path);
    const scheme = url.protocol ? str(url.protocol) + '://' : host.startsWith('{{') ? '' : 'http://';
    raw = scheme + host + (url.port ? ':' + url.port : '') + '/' + path;
  }
  if (!raw || /^(?!https?:)[a-z][\w+.-]*:/i.test(raw)) return undefined;
  const variables = new Map(rows(url.variable).map(r => [r.key, r.value]));
  raw = raw.replace(/\/:([\w-]+)(?=\/|\?|#|$)/g, (_, key: string) => '/' + (variables.get(key) || '{{' + key + '}}'));
  const query = Array.isArray(url.query) ? rows(url.query) : null;
  // The Postman raw URL may include disabled query entries. Structured rows own the query.
  if (query) {
    const hash = raw.indexOf('#');
    const fragment = hash < 0 ? '' : raw.slice(hash);
    const qs = new URLSearchParams(query.filter(r => r.enabled).map(r => [r.key, r.value])).toString()
      .replace(/%7B%7B([\w.-]+)%7D%7D/gi, '{{$1}}');
    raw = raw.split(/[?#]/, 1)[0] + (qs ? '?' + qs : '') + fragment;
  }
  const path = raw.split('#', 1)[0], q = path.indexOf('?');
  const urlRows = query ?? (q < 0 ? [] : Array.from(new URLSearchParams(path.slice(q + 1)), ([key, value]) => ({key, value, enabled:true})));
  return { path_template: raw, query_json: JSON.stringify(urlRows) };
}

export function parsePostmanCollection(content: string) {
  if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) throw new Error('Postman collection exceeds 2 MiB');
  const document = obj(JSON.parse(content.replace(/^\uFEFF/, '')));
  const info = obj(document.info);
  const name = str(info.name).trim();
  if (!name || !/\/v2\.1\.0\/(?:draft-\d+\/)?collection\.json$/.test(str(info.schema)) || !Array.isArray(document.item)) {
    throw new Error('Expected a Postman Collection v2.1 JSON file');
  }
  const requests: RequestInput[] = [];
  const folders = new Set<string>();
  const variables: Record<string, { value: string; secret: boolean }> = Object.create(null);
  for (const v of array(document.variable).map(obj)) {
    const key = str(v.key) || str(v.id);
    if (key && !v.disabled) variables[key] = { value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? ''), secret: v.type === 'secret' };
  }
  let visited = 0, skipped = 0, scripts = array(document.event).length, examples = 0;
  function walk(items: unknown[], path: string[], inheritedAuth: unknown) {
    for (const item of items.map(obj)) {
      if (++visited > 500 || path.length > 32) throw new Error('Postman collection exceeds 500 items or 32 folder levels');
      scripts += array(item.event).length;
      examples += array(item.response).length;
      if (Array.isArray(item.item)) {
        const child = [...path, str(item.name).trim() || 'Folder'];
        folders.add(child.join(' / '));
        walk(item.item, child, item.auth ?? inheritedAuth);
        continue;
      }
      const req = typeof item.request === 'string' ? { url: item.request } : obj(item.request);
      const method = (str(req.method) || 'GET').toUpperCase();
      const url = mapUrl(req.url), auth = mapAuth(req.auth ?? inheritedAuth), body = mapBody(req.body);
      if (!url || !auth || !body || !['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method)) { skipped++; continue; }
      const headers = typeof req.header === 'string'
        ? req.header.split(/\r?\n/).filter(s => s.indexOf(':') > 0).map(s => ({ key:s.slice(0, s.indexOf(':')).trim(), value:s.slice(s.indexOf(':') + 1).trim(), enabled:true }))
        : rows(req.header);
      requests.push({ name: str(item.name) || url.path_template || method, method, ...url, ...auth, ...body,
        folder: path.join(' / ') || null, headers_json: JSON.stringify(headers), sort_order: requests.length });
    }
  }
  walk(document.item, [], document.auth);
  return { name, description: description(info.description), requests, folders: [...folders], variables, skipped, scripts, examples };
}

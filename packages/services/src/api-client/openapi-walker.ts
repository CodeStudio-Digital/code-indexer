/**
 * openapi-walker — turn a raw OpenAPI 3.x / Swagger 2.0 document into a flat
 * list of operations the API client can persist as requests. We use `yaml`
 * (already a dependency) + a thin typed walker instead of swagger-parser:
 * local `$ref` resolution + a schema→example builder cover real dev specs,
 * and anything exotic degrades to an empty body (which the agent then fixes
 * from the live response — the whole point of the auto-fix loop).
 */
import { createHash } from 'node:crypto';

export interface ParsedOperation {
  method: string;
  path: string;
  name: string;
  /** Group label: first OpenAPI tag, else first path segment. */
  folder: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  bodyExample?: unknown;
  successStatus?: number;
}

export interface ParsedSpec {
  operations: ParsedOperation[];
  hash: string;
}

type AnyObj = Record<string, unknown>;
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function resolveRef(doc: AnyObj, node: unknown, depth = 0): unknown {
  if (depth > 6 || !node || typeof node !== 'object') return node;
  const ref = (node as AnyObj).$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return {};
    cur = (cur as AnyObj)[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
  }
  return resolveRef(doc, cur, depth + 1);
}

/** Build a minimal example value from a JSON schema (handles $ref, object, array, scalars). */
function schemaExample(doc: AnyObj, schemaIn: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  const schema = resolveRef(doc, schemaIn, depth) as AnyObj | undefined;
  if (!schema || typeof schema !== 'object') return null;
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = schema.type as string | undefined;
  if (type === 'object' || schema.properties) {
    const out: AnyObj = {};
    const props = (schema.properties ?? {}) as AnyObj;
    for (const [k, v] of Object.entries(props)) out[k] = schemaExample(doc, v, depth + 1);
    return out;
  }
  if (type === 'array') return [schemaExample(doc, schema.items, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  return '';
}

function firstSuccessStatus(responses: AnyObj | undefined): number | undefined {
  if (!responses) return undefined;
  for (const k of Object.keys(responses)) {
    const n = Number(k);
    if (n >= 200 && n < 300) return n;
  }
  return undefined;
}

function bodyFromOperation(doc: AnyObj, op: AnyObj): unknown {
  // OpenAPI 3.x: requestBody.content['application/json'].schema
  const rb = resolveRef(doc, op.requestBody) as AnyObj | undefined;
  const content = rb?.content as AnyObj | undefined;
  const json = content?.['application/json'] as AnyObj | undefined;
  if (json?.schema) return schemaExample(doc, json.schema);
  // Swagger 2.0: a parameter with in:'body' carries the schema
  const params = (op.parameters as unknown[] | undefined) ?? [];
  for (const p of params) {
    const param = resolveRef(doc, p) as AnyObj;
    if (param?.in === 'body' && param.schema) return schemaExample(doc, param.schema);
  }
  return undefined;
}

function operationName(op: AnyObj, method: string, path: string): string {
  const id = op.operationId as string | undefined;
  const summary = op.summary as string | undefined;
  return (id || summary || `${method} ${path}`).slice(0, 120);
}

/** Folder = first tag (how Postman groups an import); fallback to first path segment. */
function operationFolder(op: AnyObj, path: string): string {
  const tags = op.tags as unknown[] | undefined;
  if (Array.isArray(tags) && tags.length && typeof tags[0] === 'string') return tags[0];
  const seg = path.replace(/^\/+/, '').split('/').find((s) => s && !s.startsWith('{'));
  return seg ?? '';
}

async function parseRaw(raw: string, format: 'yaml' | 'json'): Promise<AnyObj> {
  if (format === 'json') return JSON.parse(raw) as AnyObj;
  const mod = (await import('yaml')) as { parse: (s: string) => unknown };
  return (mod.parse(raw) ?? {}) as AnyObj;
}

export async function parseOpenApi(raw: string, format: 'yaml' | 'json'): Promise<ParsedSpec> {
  const hash = createHash('sha256').update(raw).digest('hex');
  const doc = await parseRaw(raw, format);
  const paths = (doc.paths ?? {}) as AnyObj;
  const operations: ParsedOperation[] = [];

  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = resolveRef(doc, itemRaw) as AnyObj;
    const sharedParams = (item.parameters as unknown[] | undefined) ?? [];
    for (const verb of HTTP_VERBS) {
      const op = item[verb] as AnyObj | undefined;
      if (!op || typeof op !== 'object') continue;
      const headers: Record<string, string> = {};
      const query: Record<string, string> = {};
      const allParams = [...sharedParams, ...((op.parameters as unknown[] | undefined) ?? [])];
      for (const p of allParams) {
        const param = resolveRef(doc, p) as AnyObj;
        const name = param?.name as string | undefined;
        if (!name) continue;
        const ex = param.example != null ? String(param.example) : (param.in === 'query' ? '' : '');
        if (param.in === 'query') query[name] = ex;
        else if (param.in === 'header') headers[name] = ex;
        // 'path' params stay templated as `{name}` inside the path string
      }
      operations.push({
        method: verb.toUpperCase(),
        path,
        name: operationName(op, verb.toUpperCase(), path),
        folder: operationFolder(op, path),
        headers,
        query,
        bodyExample: bodyFromOperation(doc, op),
        successStatus: firstSuccessStatus(op.responses as AnyObj | undefined),
      });
    }
  }
  return { operations, hash };
}

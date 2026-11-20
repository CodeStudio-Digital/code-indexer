import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { ParityFixture } from './fixture.js';
import { toolContext, type ParityRoute } from './route.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** The closed tolerance list of spec-teste-paridade-e2.md, applied to one result. */
function normalize(result: ToolResult, fx: ParityFixture): unknown {
  const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  // TOL1: grep_code freshness times generated at call time.
  for (const data of [json.structuredData, (json.structuredData as { source?: unknown } | undefined)?.source]) {
    const freshness = (data as { freshness?: Record<string, unknown> } | undefined)?.freshness;
    if (freshness) for (const key of ['observedAt', 'finishedAt']) if (key in freshness) freshness[key] = '<ts>';
  }
  if (Array.isArray(json.extraUserBlocks)) json.extraUserBlocks = json.extraUserBlocks.map(block => `sha256:${sha(JSON.stringify(block))}`);
  const roots: Array<[string, string]> = [[fx.secondRoot, '<second>'], [fx.root, '<root>'], [fx.base, '<base>']];
  const variants = roots.flatMap(([path, label]) => [path, path.replace(/\\/g, '/'), path.replace(/\\/g, '\\\\')].map(v => [v, label] as const));
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const [path, label] of variants) out = out.split(path).join(label);
      return out.length > 65_536 ? `sha256:${sha(out)}:${out.length}` : out;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(json);
}

function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (diff) return diff;
    }
  }
  return path;
}

export interface ParityCase {
  id: string;
  tool: string;
  args: Record<string, unknown> | ((fx: ParityFixture) => Record<string, unknown>);
  ctx?: (route: ParityRoute) => Partial<ToolContext>;
  /** Writes and side-effect sequences run once; reads run twice to expose nondeterminism. */
  once?: boolean;
  /** Process-wide or fake setup around each call (offline owner, global doc backend). */
  before?: (route: ParityRoute) => void;
  after?: (route: ParityRoute) => void;
}

export async function callOnce(route: ParityRoute, c: ParityCase) {
  const tool = route.tools.get(c.tool);
  if (!tool) throw new Error(`${route.name}: ${c.tool} is not registered`);
  c.before?.(route);
  try {
    const ctx = toolContext(route, c.ctx?.(route));
    const args = typeof c.args === 'function' ? c.args(route.fx) : structuredClone(c.args);
    return { value: normalize(await tool.handler(args, ctx), route.fx), ctx };
  } finally { c.after?.(route); }
}

/** Run a case on one route; a read must give the same answer twice. */
export async function runOnRoute(route: ParityRoute, c: ParityCase): Promise<unknown> {
  const first = await callOnce(route, c);
  if (c.once) return first.value;
  const second = await callOnce(route, c);
  const diff = firstDiff(first.value, second.value);
  if (diff) throw new Error(`${route.name} ${c.id} is not deterministic at ${diff}`);
  return first.value;
}

/** Structural revision fields: `<generation>:<n>`, the generation drawn per database. */
const REVISION_KEYS = new Set(['structuralRevision', 'structuralRevisionAfter']);

/**
 * TOL4/TOL5, golden comparison only: fixture timestamps and each database's
 * random revision generation differ per run. The revision counter `:n` stays.
 */
export function goldenForm(value: unknown): unknown {
  const timeless = JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<time>'));
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key,
      REVISION_KEYS.has(key) && typeof child === 'string' ? child.replace(/^[0-9A-Fa-f]{32}(?=:\d+$)/, '<generation>') : walk(child)]));
  };
  return walk(timeless);
}

/**
 * Golden recorded from the MCP bridge outputs (E2). Since the bridge is gone
 * (E6) it is the native route's fixed reference: read-only, never re-recorded.
 */
export class Golden {
  private readonly stored: Record<string, unknown> | null;
  constructor(file: string) {
    this.stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }
  get missing(): boolean { return !this.stored; }
  /** The recorded form of a case; undefined when the case was never recorded. */
  expected(id: string): unknown { return this.stored?.[id]; }
  formOf(value: unknown): unknown { return goldenForm(value); }
}

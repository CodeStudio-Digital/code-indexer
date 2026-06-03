/**
 * shadcn block seeds — golden examples fetched LIVE from the user's configured
 * Shadcn_UI MCP server (not bundled static data). The caller injects an
 * `McpCall` already bound to the right server, so this module stays free of
 * the app's MCP infrastructure. Tolerant of a flaky/absent MCP: per-item
 * errors are swallowed and whatever was collected is returned.
 *
 * Used to seed `react-shadcn-vite` datasets even when the project has no
 * indexed files — the teacher grounds its generated tasks on real shadcn blocks.
 */
import type { Seed } from './types.js';

/** Bound to one MCP server by the caller: (toolName, args) → tool text result. */
export type McpCall = (toolName: string, args: Record<string, unknown>) => Promise<string>;

/** Canonical shadcn v4 blocks/components worth grounding dashboard generation on. */
const BLOCKS = ['dashboard-01', 'sidebar-07', 'login-03', 'products-01'];
const COMPONENTS = ['data-table', 'chart', 'card', 'dialog'];

const MIN_CODE_CHARS = 80;

/** Pull code out of a get_block/get_component JSON payload, tolerantly. */
function extractCode(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const files = j.files;
    if (files && typeof files === 'object') {
      const codes = Object.values(files as Record<string, unknown>).filter(
        (v): v is string => typeof v === 'string',
      );
      if (codes.length) return codes.join('\n\n');
    }
    for (const key of ['code', 'content', 'source']) {
      if (typeof j[key] === 'string') return j[key] as string;
    }
  } catch {
    // not JSON — treat the raw text as the code/snippet
  }
  return raw;
}

async function fetchOne(
  call: McpCall,
  tool: string,
  args: Record<string, unknown>,
  name: string,
): Promise<Seed | null> {
  try {
    const code = extractCode(await call(tool, args));
    if (code.trim().length < MIN_CODE_CHARS) return null;
    return {
      name: `shadcn:${name}`,
      filePath: `shadcn://${name}`,
      body: code.slice(0, 8_000),
      kind: 'block',
      source: 'shadcn-block',
    };
  } catch {
    return null; // MCP error / not found — skip this one
  }
}

export async function fetchShadcnBlockSeeds(call: McpCall, limit: number): Promise<Seed[]> {
  const seeds: Seed[] = [];
  for (const name of BLOCKS) {
    if (seeds.length >= limit) return seeds;
    const s = await fetchOne(call, 'get_block', { blockName: name, includeComponents: false }, name);
    if (s) seeds.push(s);
  }
  for (const name of COMPONENTS) {
    if (seeds.length >= limit) return seeds;
    const s = await fetchOne(call, 'get_component', { componentName: name }, name);
    if (s) seeds.push(s);
  }
  return seeds;
}

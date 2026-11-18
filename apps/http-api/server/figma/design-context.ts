import { object, type JsonObject } from './client.js';

const MAX_LAYERS = 160;
const MAX_CONTEXT_CHARS = 40_000;
const FIGMA_FILE_TYPES = new Set(['design', 'file', 'proto', 'board', 'slides', 'deck', 'draw', 'make']);
const FILE_KEY = /^[a-zA-Z0-9_-]{3,128}$/;
const NODE_ID = /^I?\d+:\d+(?:;I?\d+:\d+)*$/;

export function nodeId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Provide a valid Figma layer ID.');
  const id = value.trim().replaceAll('-', ':');
  if (!NODE_ID.test(id)) throw new Error('Provide a valid Figma layer ID, for example 12:34.');
  return id;
}

export function fileReference(input: unknown): { key: string; layer?: string } {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Provide a Figma file link or file key.');
  const value = input.trim();
  if (FILE_KEY.test(value)) return { key: value };
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || !['www.figma.com', 'figma.com'].includes(url.host)
    || url.username || url.password) throw new Error('Provide a valid HTTPS link to a Figma file.');
  const [, kind, mainKey, branch, branchKey] = url.pathname.split('/');
  const key = branch === 'branch' ? branchKey : mainKey;
  if (!FIGMA_FILE_TYPES.has(kind) || !key || !FILE_KEY.test(key)) throw new Error('The Figma link is missing a file key.');
  const selected = url.searchParams.get('node-id');
  return { key, ...(selected ? { layer: nodeId(selected) } : {}) };
}

function summarize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= 1200 ? value : value.slice(0, 1199) + '…';
  if (depth >= 4 || value == null || typeof value !== 'object') return depth >= 4 && typeof value === 'object' ? null : value;
  if (Array.isArray(value)) return value.slice(0, 16).map(item => summarize(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, summarize(item, depth + 1)]));
}

const LAYER_FIELDS = [
  'name', 'type', 'visible', 'locked', 'absoluteBoundingBox', 'size', 'relativeTransform', 'rotation',
  'layoutMode', 'layoutWrap', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutPositioning', 'itemSpacing', 'counterAxisSpacing',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'constraints', 'clipsContent',
  'opacity', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'cornerRadius', 'rectangleCornerRadii', 'effects',
  'characters', 'style', 'styles', 'boundVariables', 'componentId', 'componentProperties',
] as const;

export function childLayers(node: JsonObject): JsonObject[] {
  return Array.isArray(node.children) ? node.children.map(object) : [];
}

export function outline(node: JsonObject) {
  return { id: node.id, name: summarize(node.name), type: node.type, childCount: childLayers(node).length };
}

export function designContext(root: JsonObject, depth: number, matches?: (node: JsonObject) => boolean) {
  const nodes: JsonObject[] = [];
  let size = 0;
  let truncated = false;
  function visit(node: JsonObject, parentId: unknown, level: number): void {
    if (truncated) return;
    const children = childLayers(node);
    if (!matches || matches(node)) {
      const entry: JsonObject = { id: node.id, parentId, depth: level, childCount: children.length };
      for (const field of matches ? ['name', 'type', 'visible'] as const : LAYER_FIELDS) {
        if (node[field] !== undefined) entry[field] = summarize(node[field]);
      }
      size += JSON.stringify(entry).length;
      if (nodes.length >= MAX_LAYERS || size > MAX_CONTEXT_CHARS) {
        truncated = true;
        return;
      }
      nodes.push(entry);
    }
    if (level < depth) for (const child of children) visit(child, node.id, level + 1);
  }
  visit(root, null, 0);
  return { nodes, depth, truncated };
}

export function boundedEntries(value: unknown, offset = 0, limit = 40) {
  const entries = Object.entries(object(value));
  const items: Array<{ id: string; value: unknown }> = [];
  let size = 0;
  for (const [id, raw] of entries.slice(offset, offset + limit)) {
    const item = { id, value: summarize(raw) };
    size += JSON.stringify(item).length;
    if (items.length && size > MAX_CONTEXT_CHARS / 2) break;
    items.push(item);
  }
  const next = offset + items.length;
  return { items, total: entries.length, nextOffset: next < entries.length ? next : null };
}

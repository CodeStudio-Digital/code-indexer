import type { Element, Root, RootContent } from 'hast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { defaultUrlTransform } from 'react-markdown';
import { urlAttributes } from 'html-url-attributes';

export interface MarkdownDocument {
  rows: RootContent[];
  anchors: Record<string, number>;
}

// Parse the WHOLE document: splitting source at blank lines breaks references,
// lists, tables and open fences. This processor runs in a worker for long text.
const processor = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true });

export function parseMarkdownDocument(text: string): MarkdownDocument {
  const tree = processor.runSync(processor.parse(text)) as Root;
  const pending: Array<Root | Element> = [tree];
  while (pending.length) {
    const parent = pending.pop()!;
    for (let index = 0; index < parent.children.length; index++) {
      const child = parent.children[index];
      // Match react-markdown's safe defaults. Raw HTML is literal text, and
      // every URL-bearing property uses the upstream protocol allowlist.
      if (child.type === 'raw') parent.children[index] = { type: 'text', value: child.value };
      else if (child.type === 'element') {
        for (const [key, tags] of Object.entries(urlAttributes)) {
          if (Object.hasOwn(child.properties, key) && (tags === null || tags.includes(child.tagName))) {
            child.properties[key] = defaultUrlTransform(String(child.properties[key] || ''));
          }
        }
        pending.push(child);
      }
    }
  }
  const rows = tree.children.filter(node => node.type !== 'text' || node.value.trim() !== '')
    .flatMap(node => splitContainer(node, MAX_MARKDOWN_ROW_NODES));
  const anchors: Record<string, number> = Object.create(null);
  rows.forEach((row, index) => {
    const stack = [row];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'element') {
        if (typeof node.properties.id === 'string') anchors[node.properties.id] = index;
        stack.push(...node.children);
      }
    }
  });
  return { rows, anchors };
}

// Bound descendants, not just direct children: one list item or quoted list
// can otherwise contain thousands of DOM nodes inside a single virtual row.
export const MAX_MARKDOWN_ROW_NODES = 192;
const costs = new WeakMap<RootContent, number>();
const structuralContainers = new Set(['ul', 'ol', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr']);

function childrenOf(node: Element): Element['children'] {
  return structuralContainers.has(node.tagName)
    ? node.children.filter(child => child.type !== 'text' || child.value.trim() !== '')
    : node.children;
}
function cost(node: RootContent): number {
  const cached = costs.get(node);
  if (cached !== undefined) return cached;
  const count = 1 + (node.type === 'element' ? node.children.reduce((sum, child) => sum + cost(child), 0) : 0);
  costs.set(node, count);
  return count;
}
function part(node: Element, children: RootContent[], continuation: boolean, properties = node.properties): Element {
  const props = { ...properties };
  if (continuation) delete props.id;
  // A long logical item can span rows, but its continuation must not invent
  // another visible bullet. Ordered parents also retain the original value.
  if (continuation && node.tagName === 'li') props.style = (props.style ? String(props.style) + ';' : '') + 'list-style-type:none';
  const result: Element = { ...node, properties: props, children: children as Element['children'] };
  costs.set(result, 1 + children.reduce((sum, child) => sum + cost(child), 0));
  return result;
}
function withoutIds(node: RootContent): RootContent {
  if (node.type !== 'element') return node;
  return part(node, node.children.map(withoutIds), true);
}

function splitContainer(node: RootContent, budget: number): RootContent[] {
  if (node.type !== 'element') return [node];
  const children = childrenOf(node);
  const childLimit = node.tagName === 'ul' || node.tagName === 'ol' || node.tagName === 'blockquote'
    ? 16 : node.tagName === 'tbody' || node.tagName === 'thead' ? 32 : Infinity;
  if (cost(node) <= budget && children.length <= childLimit) return [node];
  if (node.tagName === 'table') return splitTable(node, budget);
  if (node.tagName === 'tr') return splitTableRow(node, budget);

  const result: Element[] = [];
  let group: RootContent[] = [];
  let groupCost = 1;
  let firstChild = 0;
  const start = Number(node.properties.start ?? 1);
  const flush = () => {
    if (!group.length) return;
    result.push(part(node, group, result.length > 0,
      node.tagName === 'ol' ? { ...node.properties, start: start + firstChild } : node.properties));
    group = []; groupCost = 1;
  };
  children.forEach((child, childIndex) => {
    const parts = splitContainer(child, Math.max(1, budget - 1));
    for (const [partIndex, childPart] of parts.entries()) {
      const next = node.tagName === 'ol' && childPart.type === 'element' && childPart.tagName === 'li' && parts.length > 1
        ? part(childPart, childPart.children, partIndex > 0, { ...childPart.properties, value: start + childIndex }) : childPart;
      const size = cost(next);
      if (group.length && (groupCost + size > budget || group.length >= childLimit)) flush();
      if (!group.length) firstChild = childIndex;
      group.push(next); groupCost += size;
    }
  });
  flush();
  return result.length ? result : [node];
}

// Split huge cells without changing their column. Empty spans represent the
// columns whose content belongs to another continuation row; no cell content
// is repeated or dropped, even for a row with hundreds of columns.
function splitTableRow(node: Element, budget: number): RootContent[] {
  const cells = childrenOf(node);
  const result: Element[] = [];
  let current: Array<{ index: number; node: RootContent }> = [];
  let used = 1;
  const blank = (count: number): Element => ({ type: 'element',
    tagName: cells[0]?.type === 'element' && cells[0].tagName === 'th' ? 'th' : 'td',
    properties: { colSpan: count }, children: [] });
  const flush = () => {
    if (!current.length) return;
    const children: RootContent[] = [];
    let nextIndex = 0;
    for (const cell of current) {
      if (cell.index > nextIndex) children.push(blank(cell.index - nextIndex));
      children.push(cell.node); nextIndex = cell.index + 1;
    }
    if (nextIndex < cells.length) children.push(blank(cells.length - nextIndex));
    result.push(part(node, children, result.length > 0));
    current = []; used = 1;
  };
  cells.forEach((cell, index) => {
    for (const fragment of splitContainer(cell, Math.max(1, budget - 3))) {
      const projected = used + cost(fragment) + (current.length ? current[0].index > 0 ? 1 : 0 : index > 0 ? 1 : 0)
        + (index < cells.length - 1 ? 1 : 0);
      if (current.length && (current.at(-1)!.index === index || projected > budget)) flush();
      current.push({ index, node: fragment }); used += cost(fragment);
    }
  });
  flush();
  return result;
}

function splitTable(node: Element, budget: number): RootContent[] {
  const children = childrenOf(node);
  const headers = children.filter(child => child.type === 'element' && child.tagName === 'thead');
  const bodies = children.filter(child => !(child.type === 'element' && child.tagName === 'thead'));
  const headerCost = headers.reduce((sum, header) => sum + cost(header), 0);
  const result: Element[] = [];
  // Ordinary headers repeat above every body page. An unusually large header
  // gets its own bounded rows instead of defeating the entire DOM budget.
  const repeatHeader = headerCost < Math.max(8, budget / 3);
  if (!repeatHeader) for (const header of headers) {
    for (const fragment of splitContainer(header, Math.max(1, budget - 1))) {
      result.push(part(node, [fragment], result.length > 0));
    }
  }
  for (const body of bodies) {
    for (const fragment of splitContainer(body, Math.max(1, budget - 1 - (repeatHeader ? headerCost : 0)))) {
      result.push(part(node, [
        ...(repeatHeader ? result.length ? headers.map(withoutIds) : headers : []), fragment,
      ], result.length > 0));
    }
  }
  return result.length ? result : [node];
}

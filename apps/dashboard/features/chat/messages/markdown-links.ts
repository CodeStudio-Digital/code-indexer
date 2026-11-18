import type { Element } from 'hast';
import { defaultUrlTransform } from 'react-markdown';

export interface FileLink {
  path: string;
  line?: number;
  column?: number;
  fragment?: string;
}

const drivePath = /^[a-z]:[\\/]/i;
const scheme = /^[a-z][a-z\d+.-]*:/i;
const fileWithLine = /^[^:/\\]+\.[\w-]+:\d+(?::\d+)?(?:#|$)/;

/** Only anchor destinations may become local file references. Images and
 * other URL attributes continue to use react-markdown's protocol filter. */
export function markdownUrlTransform(url: string, key: string, node: Element): string {
  if (key === 'href' && node.tagName === 'a' && (/^(?:file:|[a-z]:(?:[/\\]|%5c))/i.test(url) || fileWithLine.test(url))) {
    return parseFileLink(url) ? url : '';
  }
  return defaultUrlTransform(url);
}

export function parseFileLink(href: string, sourceFile?: string): FileLink | null {
  if (!href || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) return null;
  let raw = href;
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.host || url.search) return null;
      raw = url.pathname + url.hash;
    } catch { return null; }
  }
  const hash = raw.indexOf('#');
  let path: string, fragment: string;
  try {
    path = decodeURIComponent(hash < 0 ? raw : raw.slice(0, hash)).replace(/\\/g, '/');
    fragment = hash < 0 ? '' : decodeURIComponent(raw.slice(hash + 1));
  } catch { return null; }
  path = path.replace(/^\/([a-z]:\/)/i, '$1');
  if (!path || path.startsWith('//') || /[\x00-\x1f]/.test(path)) return null;
  if (scheme.test(path) && !drivePath.test(path) && !fileWithLine.test(path)) return null;
  const suffix = /:(\d+)(?::(\d+))?$/.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  if (!path || (!drivePath.test(path) && scheme.test(path))) return null;
  if (sourceFile && !drivePath.test(path) && !path.startsWith('/')) {
    path = sourceFile.slice(0, sourceFile.lastIndexOf('/') + 1) + path;
  }
  const location = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment) ?? suffix;
  if (location) {
    const line = Number(location[1]), column = Number(location[2] ?? 1);
    if (Number.isSafeInteger(line) && Number.isSafeInteger(column) && line > 0 && column > 0) {
      return { path, line, column };
    }
  }
  return fragment ? { path, fragment } : { path };
}

// Headings have no generated DOM ids. Keep navigation local to one Markdown
// document, since multiple messages can contain identically named sections.
export function nextHeadingSlug(text: string, used: Map<string, number>): string {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  let n = used.get(base) ?? 0;
  let slug = n ? base + '-' + n : base;
  while (used.has(slug)) slug = base + '-' + ++n;
  used.set(base, n + 1);
  if (slug !== base) used.set(slug, 1);
  return slug;
}

export function scrollToMarkdownAnchor(root: HTMLElement, fragment: string): void {
  const used = new Map<string, number>();
  const target = Array.from(root.querySelectorAll<HTMLElement>('[id], h1, h2, h3, h4, h5, h6')).find(el =>
    el.id === fragment || (/^H[1-6]$/.test(el.tagName) && nextHeadingSlug(el.textContent ?? '', used) === fragment));
  target?.scrollIntoView({ block: 'nearest' });
}

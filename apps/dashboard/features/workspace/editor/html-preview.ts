import { apiBaseUrl } from '../../../lib/api-client.js';

function encodeProjectPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function projectPreviewRootUrl(projectId: number): string {
  const base = apiBaseUrl().replace(/\/$/, '');
  return `${base}/api/projects/${projectId}/preview/`;
}

export function projectPreviewDirectoryUrl(projectId: number, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const directory = slash >= 0 ? normalized.slice(0, slash + 1) : '';
  return `${projectPreviewRootUrl(projectId)}${encodeProjectPath(directory)}${directory ? '/' : ''}`;
}

/**
 * Makes an in-memory (possibly unsaved) HTML buffer behave like a project file:
 * relative assets resolve beside the file and root-relative links stay under
 * the project preview route. Network APIs remain blocked even when scripts are
 * explicitly enabled in the sandboxed iframe.
 */
export function buildHtmlPreviewDocument(
  source: string,
  baseHref: string,
  previewRootHref: string,
): string {
  const escapedRoot = escapeAttribute(previewRootHref);
  let rewritten = source.replace(
    /(\b(?:href|src|action|formaction|poster)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi,
    (_match, prefix: string, quote: string, target: string) =>
      `${prefix}${quote}${escapedRoot}${target}${quote}`,
  );
  rewritten = rewritten.replace(
    /url\(\s*(["']?)\/(?!\/)([^)"']+)\1\s*\)/gi,
    (_match, quote: string, target: string) => `url(${quote}${escapedRoot}${target}${quote})`,
  );
  rewritten = rewritten.replace(
    /(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi,
    (_match, prefix: string, quote: string, value: string) => {
      const targets = value.split(',').map((candidate) => {
        const trimmed = candidate.trim();
        return trimmed.startsWith('/') && !trimmed.startsWith('//')
          ? `${escapedRoot}${trimmed.slice(1)}`
          : trimmed;
      });
      return `${prefix}${quote}${targets.join(', ')}${quote}`;
    },
  );

  const previewHead = [
    `<base href="${escapeAttribute(baseHref)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; object-src \'none\'">',
  ].join('');

  if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${previewHead}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(rewritten)) {
    return rewritten.replace(/<html(\s[^>]*)?>/i, (html) => `${html}<head>${previewHead}</head>`);
  }
  return `<head>${previewHead}</head>${rewritten}`;
}

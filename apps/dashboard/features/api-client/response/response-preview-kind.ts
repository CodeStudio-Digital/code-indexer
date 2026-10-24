/** Content-type → how to preview/pretty-print a response body. Pure. */
type PreviewKind = 'json' | 'html' | 'xml' | 'image' | 'text';
type PrettyLang = 'json' | 'xml' | 'html' | 'javascript' | 'plaintext';

export function contentType(headers: Record<string, string | string[] | undefined>): string {
  const v = headers['content-type'] ?? headers['Content-Type'];
  return (Array.isArray(v) ? v[0] : v ?? '').toLowerCase();
}

export function responsePreviewKind(ct: string, body: string): PreviewKind {
  if (/application\/(json|.*\+json)/.test(ct) || (!ct && /^\s*[[{]/.test(body))) return 'json';
  if (/text\/html/.test(ct)) return 'html';
  if (/xml/.test(ct)) return 'xml';
  if (/^image\//.test(ct)) return 'image';
  return 'text';
}

export function prettyLanguage(ct: string, body: string): PrettyLang {
  const kind = responsePreviewKind(ct, body);
  if (kind === 'json') return 'json';
  if (kind === 'html') return 'html';
  if (kind === 'xml') return 'xml';
  if (/javascript|ecmascript/.test(ct)) return 'javascript';
  return 'plaintext';
}

/** Pretty-printers for response bodies. Pure; best-effort (fall back to raw). */

function formatJson(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

/** Cheap XML/HTML indent — stack-based, no parser. Good enough for a preview. */
function formatXml(body: string): string {
  const tokens = body.replace(/>\s*</g, '><').replace(/></g, '>\n<').split('\n');
  let depth = 0;
  return tokens.map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (/^<\//.test(t)) depth = Math.max(0, depth - 1);
    const indented = `${'  '.repeat(depth)}${t}`;
    if (/^<[^!?]/.test(t) && !/\/>$/.test(t) && !/^<.*<\/.*>$/.test(t) && !/^<\//.test(t)) depth++;
    return indented;
  }).filter(Boolean).join('\n');
}

export function formatBody(body: string, lang: string): string {
  if (lang === 'json') return formatJson(body);
  if (lang === 'xml' || lang === 'html') return formatXml(body);
  return body;
}

/** Human-readable byte size (B / KB / MB). Shared by ResponseViewer + TimingTab. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

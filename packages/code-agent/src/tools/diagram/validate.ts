/**
 * Tolerant validation + normalization for the draw.io (mxGraph) XML the model
 * produces. We deliberately avoid a real XML-parser dependency: the scan below
 * catches the model's ACTUAL failure modes — stray `&`, unbalanced/unclosed
 * tags, a bare `<mxGraphModel>` without the `<mxfile>` envelope, a `<root>`
 * missing the two implicit cells (id="0"/id="1") — and auto-repairs the cheap
 * ones, returning a normalized string the tool persists as-is.
 *
 * The goal is to fail at the TOOL (with a precise, fixable message) rather than
 * write garbage that renders as a blank iframe.
 */

export interface ValidateResult {
  ok: boolean;
  /** Normalized XML — repaired where cheap. Meaningful on success; also returned
   *  on failure so the caller can show the model what it nearly had. */
  xml: string;
  /** Human-readable reason (only when `!ok`) — fed back to the model to fix. */
  error?: string;
}

/** Escape any `&` that doesn't already start a valid XML entity. */
function escapeStrayAmp(xml: string): string {
  return xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
}

/**
 * Tag-balance scan. Strips comments, declarations, CDATA, and attribute values
 * first so a `>`/`<` inside a label or style string can't confuse the scanner.
 * Returns an error string, or null when balanced.
 */
function checkBalanced(xml: string): string | null {
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''");
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][\w.\-:]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned))) {
    const closing = m[1] === '/';
    const selfClose = m[3] === '/';
    const name = m[2];
    if (closing) {
      const top = stack.pop();
      if (top !== name) return `unbalanced tag </${name}> (expected </${top ?? 'nothing'}>)`;
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length) return `unclosed tag(s): <${stack.join('>, <')}>`;
  return null;
}

/** Wrap a bare `<mxGraphModel>` in the canonical `.drawio` `<mxfile>` envelope. */
function ensureEnvelope(xml: string, title?: string): string {
  const trimmed = xml.trim();
  if (/<mxfile[\s>]/.test(trimmed)) return trimmed;
  if (/<mxGraphModel[\s>]/.test(trimmed)) {
    const name = (title && title.trim()) || 'Page-1';
    return `<mxfile host="codestudio">\n  <diagram name="${escapeStrayAmp(name)}">\n    ${trimmed}\n  </diagram>\n</mxfile>`;
  }
  return trimmed; // unknown shape — validation flags the missing model/root
}

/** Inject the implicit layer cells (id="0" / id="1") when the `<root>` lacks them. */
function ensureImplicitCells(xml: string): string {
  if (!/<root[\s>]/.test(xml)) return xml;
  const hasZero = /<mxCell\b[^>]*\bid="0"/.test(xml);
  const hasOne = /<mxCell\b[^>]*\bid="1"/.test(xml);
  if (hasZero && hasOne) return xml;
  const inject =
    (hasZero ? '' : '<mxCell id="0" />') + (hasOne ? '' : '<mxCell id="1" parent="0" />');
  return xml.replace(/(<root\b[^>]*>)/, `$1${inject}`);
}

/**
 * Validate + normalize draw.io mxGraph XML. `title` is used only when wrapping
 * a bare `<mxGraphModel>` into the `<mxfile>` envelope.
 */
export function validateMxXml(input: unknown, title?: string): ValidateResult {
  if (typeof input !== 'string' || !input.trim()) {
    return {
      ok: false,
      xml: '',
      error: 'diagram XML is empty — provide mxGraph XML (an <mxfile> or an <mxGraphModel> with a <root>)',
    };
  }
  let xml = escapeStrayAmp(input.trim());
  xml = ensureEnvelope(xml, title);
  xml = ensureImplicitCells(xml);

  const balErr = checkBalanced(xml);
  if (balErr) return { ok: false, xml, error: balErr };
  if (!/<mxGraphModel[\s>]/.test(xml)) {
    return { ok: false, xml, error: 'missing <mxGraphModel> — the diagram needs an mxGraphModel containing a <root>' };
  }
  if (!/<root[\s>]/.test(xml)) {
    return { ok: false, xml, error: 'missing <root> inside <mxGraphModel>' };
  }
  return { ok: true, xml };
}

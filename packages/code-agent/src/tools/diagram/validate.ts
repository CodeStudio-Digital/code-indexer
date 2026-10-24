/** Bounded lexical validation for uncompressed mxGraph XML. It checks tag
 * balance and page structure, repairs missing layer cells, and preserves the
 * supplied XML. This is not a general XML schema validator. */
import { checkBalanced } from './xml-balance.js';

export interface ValidateResult {
  ok: boolean;
  xml: string;
  error?: string;
}

function escapeStrayAmp(xml: string): string {
  return xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
}

interface LayerRoot { start: number; end: number; selfClosing: boolean; zero: boolean; one: boolean }

export function validateMxXml(input: unknown, title?: string): ValidateResult {
  const fail = (error: string, xml = ''): ValidateResult => ({ ok: false, xml, error });
  if (typeof input !== 'string' || !input.trim()) return fail('diagram XML is empty — provide an <mxGraphModel> containing a <root>');
  if (input.length > 4 * 1024 * 1024 || Buffer.byteLength(input, 'utf8') > 4 * 1024 * 1024) return fail('diagram XML exceeds 4 MiB');
  if (title && title.length > 512) return fail('diagram title exceeds 512 characters');
  let xml = escapeStrayAmp(input.trim());
  const roots: LayerRoot[] = [];
  let activeRoot: LayerRoot | undefined;
  let documentName = '', documentCount = 0, models = 0, diagrams = 0, structureError = '';
  let pageModels = 0, modelRoots = 0;
  const balanceError = checkBalanced(xml, tag => {
    if (tag.closing) {
      if (tag.name === 'root') activeRoot = undefined;
      if (tag.name === 'mxGraphModel' && modelRoots !== 1) structureError = 'each <mxGraphModel> needs one <root>';
      if (tag.name === 'diagram' && pageModels !== 1) structureError = 'each <diagram> needs one <mxGraphModel>';
      return;
    }
    if (!tag.parent) { documentName = tag.name; documentCount++; }
    if (tag.name === 'diagram') {
      diagrams++;
      pageModels = 0;
      if (tag.selfClosing) structureError = 'empty diagram page';
      if (tag.parent !== 'mxfile') structureError = '<diagram> must be inside <mxfile>';
    }
    if (tag.name === 'mxGraphModel') {
      models++;
      pageModels++; modelRoots = 0;
      if (tag.selfClosing) structureError = 'missing <root> inside <mxGraphModel>';
      if (tag.parent && tag.parent !== 'diagram') structureError = '<mxGraphModel> must be a diagram page';
    }
    if (tag.name === 'root') {
      modelRoots++;
      if (tag.parent !== 'mxGraphModel') structureError = '<root> must be inside <mxGraphModel>';
      activeRoot = { start: tag.start, end: tag.end, selfClosing: tag.selfClosing, zero: false, one: false };
      roots.push(activeRoot);
      if (tag.selfClosing) activeRoot = undefined;
    }
    if (tag.name === 'mxCell' && tag.parent === 'root' && activeRoot) {
      const id = tag.attributes.id;
      if (id === '0') activeRoot.zero = true;
      if (id === '1') activeRoot.one = true;
    }
  });
  if (balanceError) return fail(balanceError, xml);
  if (structureError) return fail(structureError, xml);
  if (documentCount !== 1 || !['mxfile', 'mxGraphModel'].includes(documentName)) return fail('expected one <mxfile> or <mxGraphModel> document', xml);
  if (!models) return fail('missing <mxGraphModel> — compressed pages must be expanded to XML', xml);
  if (roots.length !== models || (documentName === 'mxfile' && diagrams !== models)) return fail('each diagram page needs one <mxGraphModel> containing one <root>', xml);
  const parts: string[] = [];
  let cursor = 0;
  for (const root of roots) {
    const inject = (root.zero ? '' : '<mxCell id="0" />') + (root.one ? '' : '<mxCell id="1" parent="0" />');
    parts.push(xml.slice(cursor, root.end - (root.selfClosing ? 2 : 0)), root.selfClosing ? '>' : '', inject, root.selfClosing ? '</root>' : '');
    cursor = root.end;
  }
  parts.push(xml.slice(cursor));
  xml = parts.join('');
  if (documentName === 'mxGraphModel') {
    const name = escapeStrayAmp(title?.trim() || 'Page-1').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    xml = `<mxfile host="codestudio"><diagram name="${name}">${xml}</diagram></mxfile>`;
  }
  return { ok: true, xml };
}

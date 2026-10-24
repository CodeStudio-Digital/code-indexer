import { describe, it, expect } from 'vitest';
import { validateMxXml } from '../validate.js';

const FULL = `<mxfile host="codestudio"><diagram name="Page-1"><mxGraphModel><root>` +
  `<mxCell id="0" /><mxCell id="1" parent="0" />` +
  `<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>` +
  `</root></mxGraphModel></diagram></mxfile>`;

describe('validateMxXml', () => {
  it('rejects empty / non-string input', () => {
    expect(validateMxXml('').ok).toBe(false);
    expect(validateMxXml('   ').ok).toBe(false);
    expect(validateMxXml(null).ok).toBe(false);
    expect(validateMxXml(42).ok).toBe(false);
  });

  it('accepts a well-formed <mxfile> unchanged', () => {
    const r = validateMxXml(FULL);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('<mxGraphModel>');
    expect(r.xml).toContain('id="0"');
  });

  it('wraps a bare <mxGraphModel> in the <mxfile> envelope', () => {
    const bare = `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>`;
    const r = validateMxXml(bare, 'My Title');
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('<mxfile');
    expect(r.xml).toContain('My Title');
  });

  it('escapes a quoted page title without adding attributes to the envelope', () => {
    const result = validateMxXml('<mxGraphModel><root/></mxGraphModel>', 'A "quoted" <title> & more');
    expect(result.ok).toBe(true);
    expect(result.xml).toContain('name="A &quot;quoted&quot; &lt;title&gt; &amp; more"');
  });

  it('rejects excessive input/depth and malformed repeated tag starts without quadratic scanning', () => {
    expect(validateMxXml('x'.repeat(4 * 1024 * 1024 + 1))).toMatchObject({ ok: false, xml: '' });
    expect(validateMxXml('<mxGraphModel><root>' + '<tag '.repeat(100000))).toMatchObject({ ok: false });
    expect(validateMxXml('<a>'.repeat(1100))).toMatchObject({ ok: false, error: expect.stringContaining('1024') });
    expect(validateMxXml('<!DOCTYPE x><mxGraphModel><root/></mxGraphModel>').ok).toBe(false);
  });

  it('injects the implicit cells (id 0/1) when the root lacks them', () => {
    const missing = `<mxGraphModel><root>` +
      `<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell>` +
      `</root></mxGraphModel>`;
    const r = validateMxXml(missing);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('id="0"');
    expect(r.xml).toContain('id="1"');
  });

  it('escapes a stray ampersand but keeps valid entities', () => {
    const stray = `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />` +
      `<mxCell id="a" value="Tom & Jerry &amp; Co &lt;x&gt;" vertex="1" parent="1">` +
      `<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`;
    const r = validateMxXml(stray);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain('Tom &amp; Jerry &amp; Co &lt;x&gt;');
  });

  it('repairs every page, recognizes single-quoted ids and ignores tags in comments', () => {
    const xml = `<mxfile><diagram><mxGraphModel><root><mxCell id='0'/><mxCell id='1' parent='0'/></root></mxGraphModel></diagram>`
      + `<diagram><mxGraphModel><root><!-- <mxCell id="0"/><mxCell id="1"/> --></root></mxGraphModel></diagram></mxfile>`;
    const result = validateMxXml(xml);
    expect(result.ok).toBe(true);
    expect(result.xml).toContain(`<root><mxCell id='0'/><mxCell id='1' parent='0'/></root>`);
    expect(result.xml).toContain('<root><mxCell id="0" /><mxCell id="1" parent="0" /><!--');
    expect(validateMxXml('<!-- <mxGraphModel><root/> -->').ok).toBe(false);
  });

  it('expands a self-closing root and rejects misplaced roots and multiple documents', () => {
    expect(validateMxXml('<mxGraphModel><root /></mxGraphModel>').xml).toContain('<root ><mxCell id="0" /><mxCell id="1" parent="0" /></root>');
    expect(validateMxXml('<mxGraphModel/><root/>').ok).toBe(false);
    expect(validateMxXml('<mxfile><diagram><root/></diagram></mxfile>').ok).toBe(false);
  });

  it('repairs every page, recognizes single-quoted ids and ignores tags in comments', () => {
    const xml = `<mxfile><diagram><mxGraphModel><root><mxCell id='0'/><mxCell id='1' parent='0'/></root></mxGraphModel></diagram>`
      + `<diagram><mxGraphModel><root><!-- <mxCell id="0"/><mxCell id="1"/> --></root></mxGraphModel></diagram></mxfile>`;
    const result = validateMxXml(xml);
    expect(result.ok).toBe(true);
    expect(result.xml).toContain(`<root><mxCell id='0'/><mxCell id='1' parent='0'/></root>`);
    expect(result.xml).toContain('<root><mxCell id="0" /><mxCell id="1" parent="0" /><!--');
    expect(validateMxXml('<!-- <mxGraphModel><root/> -->').ok).toBe(false);
  });

  it('expands a self-closing root and rejects misplaced roots and multiple documents', () => {
    expect(validateMxXml('<mxGraphModel><root /></mxGraphModel>').xml).toContain('<root ><mxCell id="0" /><mxCell id="1" parent="0" /></root>');
    expect(validateMxXml('<mxGraphModel/><root/>').ok).toBe(false);
    expect(validateMxXml('<mxfile><diagram><root/></diagram></mxfile>').ok).toBe(false);
  });

  it('flags an unclosed tag', () => {
    const broken = `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />` +
      `<mxCell id="a" value="A" vertex="1" parent="1"></root></mxGraphModel>`;
    const r = validateMxXml(broken);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unbalanced|unclosed/i);
  });

  it('flags input with no mxGraphModel/root', () => {
    const r = validateMxXml('<foo>bar</foo>');
    expect(r.ok).toBe(false);
  });

  it('tolerates a `>` inside an attribute value (does not miscount tags)', () => {
    const withGt = `<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" />` +
      `<mxCell id="a" value="a > b" style="rounded=1;html=1" vertex="1" parent="1">` +
      `<mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`;
    const r = validateMxXml(withGt);
    expect(r.ok).toBe(true);
  });
});

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

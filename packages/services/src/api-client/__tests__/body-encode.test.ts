import { describe, it, expect } from 'vitest';
import { encodeBody, type BodyLike } from '../body-encode.js';

const base: BodyLike = { body_kind: 'none' };

describe('encodeBody', () => {
  it('none → empty', async () => {
    expect(await encodeBody(base, {})).toEqual({});
  });

  it('json resolves templates + sets content-type', async () => {
    const r = await encodeBody({ body_kind: 'json', body_json: '{"t":"{{tok}}"}' }, { tok: 'abc' });
    expect(r.body).toBe('{"t":"abc"}');
    expect(r.contentType).toBe('application/json');
  });

  it('raw picks mime from body_raw_lang', async () => {
    expect((await encodeBody({ body_kind: 'raw', body_json: '<x/>', body_raw_lang: 'xml' }, {})).contentType).toBe('application/xml');
  });

  it('urlencoded builds a form string', async () => {
    const r = await encodeBody({ body_kind: 'urlencoded', body_urlencoded_json: '[{"key":"a","value":"1","enabled":true},{"key":"b","value":"x y","enabled":true}]' }, {});
    expect(r.body).toBe('a=1&b=x+y');
    expect(r.contentType).toBe('application/x-www-form-urlencoded');
  });

  it("legacy 'form' is treated as urlencoded", async () => {
    const r = await encodeBody({ body_kind: 'form', body_urlencoded_json: '[{"key":"a","value":"1","enabled":true}]' }, {});
    expect(r.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('graphql serializes {query,variables}', async () => {
    const r = await encodeBody({ body_kind: 'graphql', body_graphql_json: JSON.stringify({ query: 'query{me}', variables: '{"x":1}' }) }, {});
    expect(JSON.parse(String(r.body))).toEqual({ query: 'query{me}', variables: { x: 1 } });
    expect(r.contentType).toBe('application/json');
  });

  it('form-data produces a multipart buffer with a fixed boundary', async () => {
    const r = await encodeBody({ body_kind: 'form-data', body_form_json: '[{"key":"name","value":"joe","enabled":true}]' }, {}, { boundary: 'B' });
    const text = String(r.body);
    expect(r.contentType).toBe('multipart/form-data; boundary=B');
    expect(text).toContain('--B');
    expect(text).toContain('Content-Disposition: form-data; name="name"');
    expect(text).toContain('joe');
    expect(text.endsWith('--B--\r\n')).toBe(true);
  });
});

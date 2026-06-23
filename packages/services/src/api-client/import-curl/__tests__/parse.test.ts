import { describe, it, expect } from 'vitest';
import { parseCurl } from '../index.js';

describe('parseCurl', () => {
  it('parses a simple GET and derives a name', () => {
    const r = parseCurl(`curl https://api.test/users/42`);
    expect(r.method).toBe('GET');
    expect(r.path_template).toBe('https://api.test/users/42');
    expect(r.name).toBe('42');
  });

  it('infers POST from -d and detects JSON', () => {
    const r = parseCurl(`curl -X POST https://api.test/u -H 'Content-Type: application/json' -d '{"a":1}'`);
    expect(r.method).toBe('POST');
    expect(r.headers).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
    expect(r.body).toEqual({ kind: 'json', content: '{"a":1}' });
  });

  it('infers POST + json from a bare -d with a JSON payload', () => {
    const r = parseCurl(`curl https://api.test/u -d '{"a":1}'`);
    expect(r.method).toBe('POST');
    expect(r.body.kind).toBe('json');
  });

  it('handles -F form fields and file uploads', () => {
    const r = parseCurl(`curl https://api.test/up -F field=val -F file=@photo.png`);
    expect(r.body).toEqual({
      kind: 'form-data',
      fields: [{ name: 'field', value: 'val' }, { name: 'file', value: '', filename: 'photo.png' }],
    });
  });

  it('parses basic auth from -u', () => {
    const r = parseCurl(`curl -u user:pass https://api.test/`);
    expect(r.auth).toEqual({ type: 'basic', username: 'user', password: 'pass' });
  });

  it('splits the query string out of the URL', () => {
    const r = parseCurl(`curl 'https://api.test/s?q=hello%20world&page=2'`);
    expect(r.path_template).toBe('https://api.test/s');
    expect(r.query).toEqual([{ key: 'q', value: 'hello world' }, { key: 'page', value: '2' }]);
  });

  it('handles line continuations and multiple -H', () => {
    const r = parseCurl(`curl https://api.test/x \\\n  -H 'A: 1' \\\n  -H 'B: 2'`);
    expect(r.headers).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: '2' }]);
  });

  it('--data-urlencode yields urlencoded fields', () => {
    const r = parseCurl(`curl https://api.test/x --data-urlencode 'name=a b' --data-urlencode 'n=1'`);
    expect(r.body).toEqual({ kind: 'urlencoded', fields: [{ name: 'name', value: 'a b' }, { name: 'n', value: '1' }] });
  });

  it('-G forces GET even with data', () => {
    const r = parseCurl(`curl -G https://api.test/x --data-urlencode 'q=1'`);
    expect(r.method).toBe('GET');
  });

  it('decodes ANSI-C $\'...\' quoting', () => {
    const r = parseCurl(`curl https://api.test/x -d $'line1\\nline2'`);
    expect(r.body.kind).toBe('raw');
    if (r.body.kind === 'raw') expect(r.body.content).toBe('line1\nline2');
  });

  it('ignores unknown flags and --compressed', () => {
    const r = parseCurl(`curl --compressed -s https://api.test/x`);
    expect(r.path_template).toBe('https://api.test/x');
  });

  it('throws on empty / no URL', () => {
    expect(() => parseCurl('')).toThrow();
    expect(() => parseCurl('curl -X POST')).toThrow();
  });
});

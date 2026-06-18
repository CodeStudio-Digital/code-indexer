import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { executeRequest, type ExecRequest } from '../execute-request.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        auth: req.headers['authorization'] ?? null,
        trace: req.headers['x-trace'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  method: 'GET', path_template: '/echo', headers_json: '[]', query_json: '[]',
  body_json: null, body_kind: 'none', ...over,
});

describe('executeRequest', () => {
  it('sends a plain request and returns status/body', async () => {
    const r = await executeRequest({ request: req(), baseUrl: base, variables: {} });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).method).toBe('GET');
  });

  it('applies a bearer auth header', async () => {
    const r = await executeRequest({
      request: req({ auth_type: 'bearer', auth_json: '{"token":"{{tok}}"}' }),
      baseUrl: base, variables: { tok: 'abc' },
    });
    expect(JSON.parse(r.body).auth).toBe('Bearer abc');
  });

  it('a pre-script can set a var used in the URL and add a header', async () => {
    const r = await executeRequest({
      request: req({
        path_template: '/echo/{{id}}',
        pre_request_script: `pm.environment.set('id','9'); pm.request.headers.set('X-Trace','t1');`,
      }),
      baseUrl: base, variables: {},
    });
    const parsed = JSON.parse(r.body);
    expect(parsed.url).toBe('/echo/9');
    expect(parsed.trace).toBe('t1');
  });

  it('encodes a json body + runs a test script', async () => {
    const r = await executeRequest({
      request: req({
        method: 'POST', body_kind: 'json', body_json: '{"n":"{{n}}"}',
        test_script: `pm.test('ok', () => pm.expect(pm.response).to.have.status(200));`,
      }),
      baseUrl: base, variables: { n: 'joe' },
    });
    expect(JSON.parse(r.body).body).toBe('{"n":"joe"}');
    expect(r.testScript?.tests).toEqual([{ name: 'ok', passed: true }]);
  });

  it('explicit header wins over auth', async () => {
    const r = await executeRequest({
      request: req({
        headers_json: '[{"key":"Authorization","value":"Bearer explicit","enabled":true}]',
        auth_type: 'bearer', auth_json: '{"token":"auth"}',
      }),
      baseUrl: base, variables: {},
    });
    expect(JSON.parse(r.body).auth).toBe('Bearer explicit');
  });
});

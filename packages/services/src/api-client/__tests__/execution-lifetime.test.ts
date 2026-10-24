import { createServer, type Server } from 'node:http';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { executeRequest, ApiRequestOutcomeUnknown, type ExecRequest } from '../execute-request.js';
import { runCollection } from '../regression-runner.js';

let server: Server, base: string, effects = 0, reads = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    if (req.url === '/lost') { effects++; res.destroy(); }
    else if (req.url === '/stall') { reads++; }
    else { reads++; res.end('ok'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const request = (over: Partial<ExecRequest> = {}): ExecRequest => ({ method: 'GET', path_template: '/', headers_json: '{}', query_json: '{}', body_kind: 'none', ...over });

it('stops a collection after an unconfirmed mutation, before dispatching its next request', async () => {
  const before = reads, beforeEffects = effects;
  await expect(runCollection({ baseUrl: base, variables: {}, includeMutating: true, requests: [
    { ...request({ method: 'POST', path_template: '/lost' }), id: 1, name: 'write', expected_status: 200, assert_json: null },
    { ...request(), id: 2, name: 'must not run', expected_status: 200, assert_json: null },
  ] })).rejects.toBeInstanceOf(ApiRequestOutcomeUnknown);
  expect(effects).toBe(beforeEffects + 1); expect(reads).toBe(before);
});

it('aborts an in-flight GET and records the partial collection as error', async () => {
  const controller = new AbortController(), before = reads;
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 80);
  try {
    const report = await runCollection({ baseUrl: base, variables: {}, signal: controller.signal, requests: [
      { ...request({ path_template: '/stall' }), id: 1, name: 'stall', expected_status: 200, assert_json: null },
      { ...request(), id: 2, name: 'must not run', expected_status: 200, assert_json: null },
    ] });
    expect(report.status).toBe('error'); expect(report.total).toBe(1); expect(reads).toBe(before + 1);
  } finally { clearTimeout(timer); }
});

it('checks authority again at the physical send after asynchronous preparation', async () => {
  const before = reads; let checks = 0;
  await expect(executeRequest({ request: request(), baseUrl: base, variables: {},
    beforeDispatch: () => { if (++checks >= 3) throw new Error('authority revoked'); },
  })).rejects.toThrow('authority revoked');
  expect(reads).toBe(before);
});

it('does not send after a failed pre-script or a disguised mutating method', async () => {
  const before = reads;
  await expect(executeRequest({ request: request({ pre_request_script: 'throw new Error("bad preparation")' }),
    baseUrl: base, variables: {},
  })).rejects.toThrow('Pre-request script failed');
  const result = await runCollection({ baseUrl: base, variables: {}, requests: [{
    ...request({ pre_request_script: 'pm.request.method = "POST";' }), id: 1, name: 'changed', expected_status: 200, assert_json: null,
  }] });
  expect(result.results[0].reason).toContain('includeMutating'); expect(reads).toBe(before);
});

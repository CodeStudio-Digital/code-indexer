import { describe, expect, it, vi } from 'vitest';
import { bodyLimit, cors } from '../middleware.js';
import { HttpRouter } from '../router.js';

describe('Fetch routing', () => {
  it('runs mounted middleware in order and stops at its rejection response', async () => {
    const child = new HttpRouter();
    const handled = vi.fn();
    child.use('*', async (c, next) => {
      c.set('caller', 'local');
      await next();
      c.header('X-Visited', 'true');
    });
    child.use('*', (c, next) => c.req.header('authorization') ? next() : c.text('Unauthorized', 401));
    child.all('/', c => {
      handled();
      return c.json({ caller: c.get('caller') });
    });

    const app = new HttpRouter().route('/mcp', child);
    const denied = await app.request('/mcp');
    expect(denied.status).toBe(401);
    expect(denied.headers.get('x-visited')).toBe('true');
    expect(handled).not.toHaveBeenCalled();
    const allowed = { headers: { authorization: 'synthetic' } };
    expect(await (await app.request('/mcp', allowed)).json()).toEqual({ caller: 'local' });
    expect((await app.request('/mcp/', allowed)).status).toBe(404);
  });

  it('applies wildcard guards to encoded paths and decodes matched parameters once', async () => {
    const app = new HttpRouter();
    app.use('/projects/:id/ssh/*', (c, next) => c.env?.inProcess ? next() : c.text('Forbidden', 403));
    app.get('/projects/:id/ssh/:name', c => c.json({
      id: c.req.param('id'), name: c.req.param('name'), first: c.req.query('tag'), all: c.req.queries('tag'),
    }));
    const url = '/projects/2/%73sh/a%252Fb?tag=one&tag=two';
    expect((await app.request(url)).status).toBe(403);
    const trusted = await app.request(url, undefined, { inProcess: true });
    expect(await trusted.json()).toEqual({ id: '2', name: 'a%2Fb', first: 'one', all: ['one', 'two'] });
    const head = await app.request(url, { method: 'HEAD' }, { inProcess: true });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it('applies the allowlist to preflight without calling a route', async () => {
    const allowed = 'http://localhost:7317';
    const app = new HttpRouter().use('*', cors({ origin: value => value === allowed ? value : null, credentials: true }));
    const request = (origin: string) => app.request('/data', { method: 'OPTIONS', headers: {
      origin, 'access-control-request-headers': 'content-type',
    } });
    const response = await request(allowed);
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowed);
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(response.headers.get('vary')).toContain('Access-Control-Request-Headers');
    expect((await request('https://outside.invalid')).headers.has('access-control-allow-origin')).toBe(false);
  });

  it('rejects oversized bodies by byte count even when a caller supplies a smaller length', async () => {
    const app = new HttpRouter().post('/', bodyLimit({ maxSize: 5, onError: c => c.json({ error: 'over limit' }, 413) }), async c => {
      const value = await c.req.json().catch(() => ({}));
      return c.json(value);
    });
    const post = (body: string) => app.request('/', { method: 'POST', body, headers: { 'content-length': '3' } });
    expect(await (await post('"é"')).json()).toBe('é');
    const oversized = await post('"éé"');
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'over limit' });
  });
});

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { mountManualSends } from '../manual-sends.js';

it('scopes a reservation to its project, accepts only one dispatch and cancels an active send', async () => {
  const app = new Hono();
  const guard = mountManualSends(app);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  app.post('/api/projects/:projectId/dispatch', guard, async c => {
    const signal = c.get('manualSendSignal');
    const stopped = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    started();
    await stopped;
    return c.json({ cancelled: signal.aborted });
  });
  const base = '/api/projects/1/api-client/sends';
  const { id } = await (await app.request(base, { method: 'POST' })).json();
  const submit = (project: number) => app.request('/api/projects/' + project + '/dispatch', { method: 'POST', headers: { 'X-CodeStudio-Send-Id': id } });
  expect((await submit(2)).status).toBe(409);
  const result = submit(1);
  await ready;
  expect((await submit(1)).status).toBe(409);
  await app.request(base + '/' + id, { method: 'DELETE' });
  expect(await (await result).json()).toEqual({ cancelled: true });
  expect((await submit(1)).status).toBe(409);
});

it('honors cancellation before dispatch and keeps legacy sends usable', async () => {
  const app = new Hono();
  const guard = mountManualSends(app);
  let dispatched = 0;
  app.post('/api/projects/:projectId/dispatch', guard, c => { dispatched++; return c.text('ok'); });
  const base = '/api/projects/1/api-client/sends';
  const { id } = await (await app.request(base, { method: 'POST' })).json();
  await app.request(base + '/' + id, { method: 'DELETE' });
  const url = '/api/projects/1/dispatch';
  expect((await app.request(url, { method: 'POST', headers: { 'X-CodeStudio-Send-Id': id } })).status).toBe(409);
  expect(dispatched).toBe(0);
  expect((await app.request(url, { method: 'POST' })).status).toBe(200);
  expect(dispatched).toBe(1);
});

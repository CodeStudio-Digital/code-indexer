/** Local disposable PostgreSQL only. No operational database is accepted. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createDriver } from '@mcp/db-drivers/factory.js';

const driver = await createDriver({ engine: 'postgres', connectionString: 'postgres://postgres:fixture-only-local@127.0.0.1:55432/postgres' });
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
try {
  const rssBefore = process.memoryUsage().rss, start = performance.now();
  const result = await driver.runQuery("SELECT g, repeat('x', 1024) AS payload FROM generate_series(1, 1000000) AS g", { maxRows: 200, timeoutMs: 10_000 });
  const large = { rows: result.rows.length, truncated: result.truncated, acquisition: result.acquisition,
    timings: result.timings, elapsedMs: performance.now() - start, rssDelta: process.memoryUsage().rss - rssBefore };
  assert.equal(result.rows.length, 200); assert.equal(result.truncated, true);
  assert.equal(result.acquisition?.mode, 'cursor');
  assert.ok(result.acquisition && result.acquisition.observedRows >= 201 && result.acquisition.observedRows <= 329);
  assert.ok(result.acquisition.retainedBytes <= result.acquisition.maxBytes);
  assert.ok(result.timings);
  assert.equal(result.timings.version, 1);
  assert.ok(typeof result.timings.acquireMs === 'number' && result.timings.acquireMs >= 0);
  assert.ok(typeof result.timings.executeFetchMs === 'number' && result.timings.executeFetchMs > 0);
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const cancelStart = performance.now();
  const pending = controllers.map(c => driver.runQuery('SELECT pg_sleep(30)', { signal: c.signal, timeoutMs: 30_000 })
    .then(() => ({ cancelled: false }), () => ({ cancelled: true })));
  const timer = setTimeout(() => controllers.forEach(c => c.abort()), 200);
  const cancelled = await Promise.all(pending); clearTimeout(timer);
  const cancelMs = performance.now() - cancelStart;
  assert.ok(cancelled.every(r => r.cancelled) && cancelMs < 2000, `Saturated cancellation: ${cancelMs}ms`);
  const timings: number[] = [];
  for (let i = 0; i < 210; i++) {
    const t = performance.now(); await driver.runQuery('SELECT 1 AS healthy', { maxRows: 1 });
    if (i >= 10) timings.push(performance.now() - t);
  }
  timings.sort((a, b) => a - b);
  mkdirSync('.tmp/agent-ide-reliability', { recursive: true });
  writeFileSync('.tmp/agent-ide-reliability/database-performance.json', JSON.stringify({ large,
    cancellation: { requests: 3, elapsedMs: cancelMs }, warm: { samples: 200, p95Ms: timings[189] },
    hostLagP95Ms: lag.percentile(95) / 1e6, at: new Date().toISOString() }, null, 2));
  console.log('PASS million-row cursor, cancellation under saturation, 200 warm samples');
} finally { lag.disable(); await driver.close(); }

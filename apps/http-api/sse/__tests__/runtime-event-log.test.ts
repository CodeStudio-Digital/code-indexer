import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, publish } from '../../coder-bus.js';
import { asSessionId } from '@mcp/session-storage';

interface RuntimeLogModule {
  installRuntimeEventLog: typeof import('../runtime-event-log.js').installRuntimeEventLog;
  getRuntimeEventLog: typeof import('../runtime-event-log.js').getRuntimeEventLog;
  __flushRuntimeEventLogsForTests: typeof import('../runtime-event-log.js').__flushRuntimeEventLogsForTests;
  __resetRuntimeEventLogsForTests: typeof import('../runtime-event-log.js').__resetRuntimeEventLogsForTests;
}

describe.sequential('runtime event log', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-runtime-log-'));
  let runtime: RuntimeLogModule;
  const sessionId = (n: number) =>
    asSessionId(`00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);
  const location = (n: number) => {
    const bundlePath = path.join(root, String(sessionId(n)));
    mkdirSync(bundlePath, { recursive: true });
    return { bundlePath };
  };

  beforeAll(async () => {
    process.env.MCP_RUNTIME_LOG_SKIP_DELTAS = '1';
    vi.resetModules();
    runtime = await import('../runtime-event-log.js');
  });

  afterAll(async () => {
    await runtime.__flushRuntimeEventLogsForTests();
    runtime.__resetRuntimeEventLogsForTests();
    delete process.env.MCP_RUNTIME_LOG_SKIP_DELTAS;
    rmSync(root, { recursive: true, force: true });
  });

  it('drops coder and runner delta vocabularies while keeping semantic events', async () => {
    const bus = createBus(new AbortController());
    const id = sessionId(1);
    const bundle = location(1);
    const detach = runtime.installRuntimeEventLog(
      bus,
      'coder',
      id,
      bundle,
    );

    publish(bus, 'text', { text: 'visible in persisted message' });
    publish(bus, 'thinking', { text: 'visible in persisted message' });
    publish(bus, 'text_delta', { text: 'runner vocabulary' });
    publish(bus, 'thinking_delta', { text: 'runner vocabulary' });
    publish(bus, 'worker_log', { level: 'info', message: 'kept' });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    expect(
      (await runtime.getRuntimeEventLog('coder', id, bundle))
        .map((event) => event.event),
    ).toEqual(['worker_log']);
  });

  it('samples duplicate progress and keeps changed phases', async () => {
    const bus = createBus(new AbortController());
    const id = sessionId(2);
    const bundle = location(2);
    const detach = runtime.installRuntimeEventLog(
      bus,
      'coder',
      id,
      bundle,
    );
    const base = { opId: 'op:1', status: 'running', phase: 'streaming' };

    publish(bus, 'operation_progress', base);
    publish(bus, 'operation_progress', { ...base, elapsedMs: 100 });
    publish(bus, 'operation_progress', { ...base, phase: 'tool' });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    const progress = (await runtime.getRuntimeEventLog('coder', id, bundle))
      .filter((event) => event.event === 'operation_progress');
    expect(progress).toHaveLength(2);
    expect(progress.map((event) => (event.data as { phase: string }).phase)).toEqual(['streaming', 'tool']);
  });

  it('caps oversized event payloads before memory and disk retention', async () => {
    const bus = createBus(new AbortController());
    const id = sessionId(3);
    const bundle = location(3);
    const detach = runtime.installRuntimeEventLog(
      bus,
      'coder',
      id,
      bundle,
    );

    publish(bus, 'tool_call_result', {
      id: 'large-result',
      name: 'code_exec',
      result: 'x'.repeat(256 * 1024),
    });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    const [event] = await runtime.getRuntimeEventLog('coder', id, bundle);
    expect(event.data).toMatchObject({
      id: 'large-result',
      name: 'code_exec',
      runtimeLogTruncated: true,
    });
    const directory = path.join(
      bundle.bundlePath,
      'events',
      'runtime',
      'stream',
    );
    const [fileName] = readdirSync(directory)
      .filter((name) => name.endsWith('.json'));
    expect(readFileSync(path.join(directory, fileName!), 'utf8').length)
      .toBeLessThan(64 * 1024);
  });
});

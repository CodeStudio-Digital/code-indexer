import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBus, publish } from '../../coder-bus.js';

interface RuntimeLogModule {
  installRuntimeEventLog: typeof import('../runtime-event-log.js').installRuntimeEventLog;
  getRuntimeEventLog: typeof import('../runtime-event-log.js').getRuntimeEventLog;
  __flushRuntimeEventLogsForTests: typeof import('../runtime-event-log.js').__flushRuntimeEventLogsForTests;
  __resetRuntimeEventLogsForTests: typeof import('../runtime-event-log.js').__resetRuntimeEventLogsForTests;
}

describe.sequential('runtime event log', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-runtime-log-'));
  let runtime: RuntimeLogModule;

  beforeAll(async () => {
    process.env.MCP_RUNTIME_EVENT_LOG_DIR = root;
    process.env.MCP_RUNTIME_LOG_SKIP_DELTAS = '1';
    vi.resetModules();
    runtime = await import('../runtime-event-log.js');
  });

  afterAll(async () => {
    await runtime.__flushRuntimeEventLogsForTests();
    runtime.__resetRuntimeEventLogsForTests();
    delete process.env.MCP_RUNTIME_EVENT_LOG_DIR;
    delete process.env.MCP_RUNTIME_LOG_SKIP_DELTAS;
    rmSync(root, { recursive: true, force: true });
  });

  it('drops coder and runner delta vocabularies while keeping semantic events', async () => {
    const bus = createBus(new AbortController());
    const detach = runtime.installRuntimeEventLog(bus, 'coder', 1);

    publish(bus, 'text', { text: 'visible in persisted message' });
    publish(bus, 'thinking', { text: 'visible in persisted message' });
    publish(bus, 'text_delta', { text: 'runner vocabulary' });
    publish(bus, 'thinking_delta', { text: 'runner vocabulary' });
    publish(bus, 'worker_log', { level: 'info', message: 'kept' });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    expect(runtime.getRuntimeEventLog('coder', 1).map((event) => event.event)).toEqual(['worker_log']);
  });

  it('samples duplicate progress and keeps changed phases', async () => {
    const bus = createBus(new AbortController());
    const detach = runtime.installRuntimeEventLog(bus, 'coder', 2);
    const base = { opId: 'op:1', status: 'running', phase: 'streaming' };

    publish(bus, 'operation_progress', base);
    publish(bus, 'operation_progress', { ...base, elapsedMs: 100 });
    publish(bus, 'operation_progress', { ...base, phase: 'tool' });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    const progress = runtime.getRuntimeEventLog('coder', 2)
      .filter((event) => event.event === 'operation_progress');
    expect(progress).toHaveLength(2);
    expect(progress.map((event) => (event.data as { phase: string }).phase)).toEqual(['streaming', 'tool']);
  });

  it('caps oversized event payloads before memory and disk retention', async () => {
    const bus = createBus(new AbortController());
    const detach = runtime.installRuntimeEventLog(bus, 'coder', 3);

    publish(bus, 'tool_call_result', {
      id: 'large-result',
      name: 'code_exec',
      result: 'x'.repeat(256 * 1024),
    });
    await runtime.__flushRuntimeEventLogsForTests();
    detach();

    const [event] = runtime.getRuntimeEventLog('coder', 3);
    expect(event.data).toMatchObject({
      id: 'large-result',
      name: 'code_exec',
      runtimeLogTruncated: true,
    });
    const file = path.join(root, 'coder', '3.jsonl');
    expect(readFileSync(file, 'utf8').length).toBeLessThan(64 * 1024);
  });
});

import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { FileSessionRepository, SessionLocator } from '../../index.js';
import { FsSessionStore } from '../fs-session-store.js';
import { FsTurnTelemetryRepository, type FsTurnTelemetryInput } from '../turn-telemetry.js';
import { FsPipelineTelemetrySink } from '../pipeline-telemetry.js';

it('acknowledges bounded telemetry before disk and drains it on close without inflating authoritative usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deferred-diagnostics-'));
  const project = join(root, 'project');
  await mkdir(project);
  const locator = new SessionLocator({ dataDir: join(root, 'data'), projectRootResolver: {
    resolveProjectRoot: () => project, listProjectRoots: () => [{ project_id: 1, root_path: project }],
  } });
  const repository = new FileSessionRepository({ locator });
  let store = new FsSessionStore({ locator, repository });
  try {
    const session = await store.createSession({ project_id: 1, title: 'Metrics', provider: 'test', model: 'test' });
    const location = (await store.getSessionLocation(session.id))!;
    const telemetry = new FsTurnTelemetryRepository(store);
    const event: FsTurnTelemetryInput = { session_id: session.id, run_id: '00000000-0000-4000-8000-000000000001', turn: 1,
      is_subagent: false, input_tokens: 23, output_tokens: 7, tools_called: [], tool_count: 0,
      provider: 'test', model: 'test', cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      thinking_tokens: 0, history_chars: 0, largest_tool_result_chars: 0, compaction_triggered: false,
      summarizer_ran: false, paginate_count: 0 };
    const id = await telemetry.recordTurnTelemetry(event);
    expect(id).not.toBeNull();
    const file = join(location.bundle_path, 'metrics', 'turns', `${id}.json`);
    expect(existsSync(file)).toBe(false);
    await store.close();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ input_tokens: 23, output_tokens: 7, turns: 0 });
    store = new FsSessionStore({ locator });
    expect(await store.getMetricsSummary(session.id)).toMatchObject({ turns: 0, tokens: { input: 0, output: 0 } });
  } finally {
    await store.close();
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('deferred-diagnostics-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

it('forwards active-worker diagnostics without trying to acquire a competing host lease', async () => {
  const forward = vi.fn(async () => true);
  const getSessionLocation = vi.fn();
  const enqueueDiagnostic = vi.fn();
  const flushDiagnostics = vi.fn(async () => undefined);
  const sink = new FsPipelineTelemetrySink({ getSessionLocation, repository: { enqueueDiagnostic, flushDiagnostics } } as never, forward);
  const event = { sessionId: 'owner-session', stage: 'rerank' };
  sink.emit(event);
  await sink.flush();
  expect(forward).toHaveBeenCalledWith('owner-session', event);
  expect(getSessionLocation).not.toHaveBeenCalled();
  expect(enqueueDiagnostic).not.toHaveBeenCalled();
});

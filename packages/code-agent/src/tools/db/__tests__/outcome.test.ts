import { beforeEach, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../core/tool.js';
import { ToolRegistry } from '../../../core/registry.js';
import { ToolCallLedger } from '../../../core/tool-call-ledger.js';
import { dbTools } from '../tools.js';

const fake = vi.hoisted(() => ({ acquire: vi.fn(), query: vi.fn(), command: vi.fn() }));
vi.mock('../pool.js', () => ({ acquireAgentDriver: fake.acquire }));
vi.mock('../shared.js', () => ({ CONNECTION_PARAM: {}, clampMaxRows: () => 200,
  pickFromCtx: () => ({ ok: true, value: { name: 'fixture', conn: { engine: 'sqlite' } } }), resolveToolScope: vi.fn() }));
const get = (name: string) => dbTools.find(tool => tool.name === name)!;
const ctx = (extra: Partial<ToolContext> = {}) => ({ cwd: process.cwd(), projectName: 'fixture', ...extra }) as ToolContext;
beforeEach(() => {
  vi.resetAllMocks();
  fake.acquire.mockResolvedValue({ driver: { runQuery: fake.query, runCommand: fake.command }, meta: { kind: 'relational' }, spec: null });
});

it('does not repeat a mutation whose successful server effect lost its ACK', async () => {
  let effects = 0;
  fake.query.mockImplementation(async () => { effects++; throw new Error('connection lost'); });
  const registry = new ToolRegistry(); registry.register(get('db_query'));
  const context = ctx({ toolCallLedger: new ToolCallLedger() });
  const args = { sql: 'INSERT INTO items(name) VALUES (?)', params: ['fixture'] };
  expect(await registry.invoke('db_query', args, context)).toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
  expect(await registry.invoke('db_query', args, context)).toMatchObject({ effectOutcome: 'unknown' });
  expect(effects).toBe(1);
});
it.each(['SELECT 1', 'DELETE FROM items'])('cancels stalled %s without waiting for a driver that ignores cancellation', async sql => {
  const controller = new AbortController(); let complete!: (value: unknown) => void;
  fake.query.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = get('db_query').handler({ sql }, ctx({ signal: controller.signal }));
  await vi.waitFor(() => expect(fake.query).toHaveBeenCalledOnce()); controller.abort();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.effectOutcome).toBe(sql.startsWith('SELECT') ? undefined : 'unknown');
  complete({ rows: [], fields: [], rowCount: 1 });
});
it('cancellation during acquisition prevents a late database write', async () => {
  const controller = new AbortController(); let complete!: (value: unknown) => void;
  fake.acquire.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = get('db_query').handler({ sql: 'DELETE FROM items' }, ctx({ signal: controller.signal }));
  await vi.waitFor(() => expect(fake.acquire).toHaveBeenCalledOnce()); controller.abort();
  expect(await pending).toMatchObject({ error: { kind: 'cancelled', retryable: false } });
  complete({ driver: { runQuery: fake.query }, meta: { kind: 'relational' }, spec: null });
  await Promise.resolve(); expect(fake.query).not.toHaveBeenCalled();
});
it('retains uncertain Redis effects', async () => {
  fake.acquire.mockResolvedValue({ driver: { runCommand: fake.command }, meta: { kind: 'keyvalue' }, spec: null });
  fake.command.mockRejectedValue(new Error('response lost'));
  expect(await get('db_command').handler({ command: { args: ['SET', 'fixture', 'value'] } }, ctx()))
    .toMatchObject({ effectOutcome: 'unknown', error: { retryable: false } });
});
it.each([{ op: 'find', args: ['DEL', 'key'] }, { op: 'deleteOne', args: ['GET', 'key'] }])(
  'mixed Mongo/Redis shapes never bypass the write permission gate: %o', command => {
    expect(get('db_command').riskOf!({ command })).toBe('write');
  });
it('preserves unambiguous read classification for each engine', () => {
  expect(get('db_command').riskOf!({ command: { op: 'find' } })).toBe('read');
  expect(get('db_command').riskOf!({ command: { args: ['GET', 'key'] } })).toBe('read');
});

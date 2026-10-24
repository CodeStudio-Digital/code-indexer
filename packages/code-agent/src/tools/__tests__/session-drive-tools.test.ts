import { expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { readPlanTool, saveNoteTool, listNotesTool, recallInvestigationsTool } from '../session-drive-tools.js';

function harness() {
  const drive = { assertCurrent: vi.fn(), readActivePlan: vi.fn(), remember: vi.fn(), listMemory: vi.fn(), recallInvestigations: vi.fn() };
  const ctx = { sessionDrive: drive, currentToolUseId: 'attributed-note' } as unknown as ToolContext;
  return { drive, ctx };
}
it('rejects invalid input before storage and returns all supported note kinds', async () => {
  const { drive, ctx } = harness();
  for (const args of [{ limit: NaN }, { limit: 1.5 }, { offset: -1 }, { offset: 10001 }, { kind: 'unknown' }]) {
    expect((await listNotesTool.handler(args, ctx)).isError).toBe(true);
  }
  expect(drive.listMemory).not.toHaveBeenCalled();
  drive.listMemory.mockResolvedValue([{ title: 'x', body: 'complete', kind: 'procedure', pinned: false, updated_at: '' },
    { title: 'y', body: 'next', kind: 'procedure', pinned: false, updated_at: '' }]);
  const result = await listNotesTool.handler({ kind: 'procedure', limit: 1, offset: 0 }, ctx);
  expect(result.content).toContain('offset=1'); expect(result.content).not.toContain('next');
  expect(drive.listMemory).toHaveBeenCalledWith({ kind: 'procedure', limit: 2, offset: 0, signal: undefined });
});
it('does not hide storage failures or invoke storage after cancellation or revocation', async () => {
  const { drive, ctx } = harness();
  drive.readActivePlan.mockRejectedValue(new Error('disk corruption'));
  await expect(readPlanTool.handler({}, ctx)).rejects.toThrow('disk corruption');
  ctx.signal = AbortSignal.abort();
  await expect(listNotesTool.handler({}, ctx)).rejects.toThrow();
  expect(drive.listMemory).not.toHaveBeenCalled();
  ctx.signal = undefined; drive.assertCurrent.mockImplementation(() => { throw new Error('revoked'); });
  await expect(recallInvestigationsTool.handler({ query: 'auth' }, ctx)).rejects.toThrow('revoked');
  expect(drive.recallInvestigations).not.toHaveBeenCalled();
});
it('passes attributed operation IDs and a late publication guard, and keeps failures uncertain', async () => {
  const { drive, ctx } = harness();
  drive.remember.mockImplementation(async (input, publish) => { publish(); return { title: input.title }; });
  expect((await saveNoteTool.handler({ title: 'Chosen DB', body: 'SQLite', kind: 'decision' }, ctx)).isError).not.toBe(true);
  expect(drive.remember).toHaveBeenCalledWith({ title: 'Chosen DB', body: 'SQLite', kind: 'decision', pinned: false,
    operation_id: 'save_note:attributed-note' }, expect.any(Function));
  drive.remember.mockRejectedValue(new Error('lost commit ACK'));
  expect((await saveNoteTool.handler({ title: 'Chosen DB', body: 'SQLite' }, ctx)).effectOutcome).toBe('unknown');
});
it('rejects malformed notes and cross-session compatibility writes before mutation', async () => {
  const { drive, ctx } = harness();
  for (const extra of [{ title: 'x'.repeat(513) }, { body: 'x'.repeat(64001) }, { kind: 'bad' }, { pinned: 'yes' }, { scope: 'user' }]) {
    expect((await saveNoteTool.handler({ title: 'key', body: 'value', ...extra }, ctx)).isError).toBe(true);
  }
  expect(drive.remember).not.toHaveBeenCalled();
});
it.each(['project', 'user'])('legacy %s notes do not claim success without persistence or after a lost response', async scope => {
  const save = vi.fn().mockResolvedValue(null);
  const ctx = { [scope === 'user' ? 'userMemory' : 'projectMemory']: { save } } as unknown as ToolContext;
  expect((await saveNoteTool.handler({ title: 'x', body: 'y', scope }, ctx)).isError).toBe(true);
  save.mockRejectedValueOnce(new Error('ACK lost'));
  expect((await saveNoteTool.handler({ title: 'x', body: 'y', scope }, ctx)).effectOutcome).toBe('unknown');
});
it('does not advertise a continuation beyond the maximum offset or describe an empty page as empty storage', async () => {
  const { drive, ctx } = harness();
  drive.listMemory.mockResolvedValue([{ title: 'x', body: 'a', kind: 'fact' }, { title: 'y', body: 'b', kind: 'fact' }]);
  const last = await listNotesTool.handler({ limit: 1, offset: 10000 }, ctx);
  expect(last.content).toContain('maximum browsing offset'); expect(last.content).not.toContain('offset=10001');
  drive.listMemory.mockResolvedValue([]);
  expect((await listNotesTool.handler({ offset: 50 }, ctx)).content).toContain('No notes in this page');
});

/**
 * Phase D2 — `write_shared_file` / `append_shared_file` must refuse the
 * `__docs__/` namespace: that prefix is the durable mirror `docs_write`
 * maintains, and letting the generic drive tools scribble there would
 * desync the sandbox copy from the mirror (and lie to the Docs tab's
 * provenance badges). The error must point the agent at `docs_write`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { appendSharedFile, writeSharedFile } from '../shared-drive-tools.js';

const COMPANY_SESSION_ID = 'c0000000-0000-4000-8000-000000000001';
const AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000001';
const SCOPE_KEY = `ses:${COMPANY_SESSION_ID}`;

function fakeCtx() {
  const write = vi.fn().mockReturnValue({ path: 'specs/x.md', sizeBytes: 5 });
  const append = vi.fn().mockReturnValue({ path: 'specs/x.md', sizeBytes: 10 });
  const ctx = {
    companyContext: {
      agentRole: 'dev',
      agentRunId: AGENT_RUN_ID,
      orchestrator: {
        driveStore: {
          resolveScopeKey: () => SCOPE_KEY,
          write,
          append,
        },
      },
    },
  } as unknown as ToolContext;
  return { ctx, write, append };
}

describe('write_shared_file docs-mirror guard', () => {
  it('rejects __docs__/ paths without touching the drive and points at docs_write', async () => {
    const { ctx, write } = fakeCtx();
    const res = await writeSharedFile.handler({ path: '__docs__/main/adr/0001.md', content: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('__docs__/');
    expect(res.content).toContain('docs_write');
    expect(write).not.toHaveBeenCalled();
  });

  it('still writes ordinary work-artifact paths', async () => {
    const { ctx, write } = fakeCtx();
    const res = await writeSharedFile.handler({ path: 'specs/x.md', content: 'hello' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(write).toHaveBeenCalledWith(SCOPE_KEY, 'specs/x.md', 'hello', {
      role: 'dev',
      agentRunId: AGENT_RUN_ID,
    });
  });
});

describe('append_shared_file docs-mirror guard', () => {
  it('rejects __docs__/ paths (append creates files too)', async () => {
    const { ctx, append } = fakeCtx();
    const res = await appendSharedFile.handler({ path: '__docs__/main/log.md', content: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('docs_write');
    expect(append).not.toHaveBeenCalled();
  });

  it('still appends ordinary paths', async () => {
    const { ctx, append } = fakeCtx();
    const res = await appendSharedFile.handler({ path: 'notes/log.md', content: 'x' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(append).toHaveBeenCalled();
  });
});

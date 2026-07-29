import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  invokePreview,
  previewKey,
  previewRpcTimeoutMs,
  setGlobalPreviewDevtools,
  type PreviewInvoke,
} from '@mcp/code-agent/tools/preview/bridge.js';
import {
  previewConsoleTool,
  previewNetworkTool,
  previewSnapshotTool,
} from '@mcp/code-agent/tools/preview/inspect.js';
import {
  asAgentRunId,
  asCompanySessionId,
  asSessionId,
} from '@mcp/session-storage';
import type { CompanyContext } from '@mcp/company/types.js';

afterEach(() => setGlobalPreviewDevtools(null));

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000007');
const ctx = {
  sessionId: SESSION_ID,
  cwd: '/tmp',
  projectName: 'preview-test',
} as ToolContext;

describe('preview inspector output ownership', () => {
  it('passes a large inspector payload intact to the central finalizer', async () => {
    const payload = `BEGIN-${'x'.repeat(10_000)}-TRUE-END`;
    const sourceTruncations = [{
      technique: 'preview-console-window',
      inputSize: 80,
      outputSize: 50,
      unit: 'items' as const,
      recoverable: true,
    }];
    setGlobalPreviewDevtools({
      invoke: async () => ({ logs: [{ text: payload }], sourceTruncations }),
    });

    const result = await previewConsoleTool.handler({}, ctx);

    expect(result.content.length).toBeGreaterThan(8_000);
    expect(result.content).toContain('-TRUE-END');
    expect(result.sourceTruncations).toEqual(sourceTruncations);
  });

  it('forwards progressive network limits to the backend', async () => {
    const invoke = vi.fn(async (_request: PreviewInvoke) => ({ requests: [] }));
    setGlobalPreviewDevtools({ invoke });

    await previewNetworkTool.handler({
      includeBody: true,
      bodyMaxChars: 75_000,
      bodyTotalMaxChars: 500_000,
      limit: 120,
      urlFilter: '/api/',
    }, ctx);

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      key: `coder-${SESSION_ID}`,
      method: 'network',
      args: expect.objectContaining({
        includeBody: true,
        bodyMaxChars: 75_000,
        bodyTotalMaxChars: 500_000,
        limit: 120,
        urlFilter: '/api/',
      }),
    }));
  });

  it('turns backend error payloads into tool errors', async () => {
    setGlobalPreviewDevtools({ invoke: async () => ({ error: 'CDP command failed' }) });

    const result = await previewConsoleTool.handler({}, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('CDP command failed');
  });

  it('renders snapshot refs as compact model-facing lines', async () => {
    setGlobalPreviewDevtools({
      invoke: async () => ({
        page: { title: 'Demo', url: 'http://localhost:5173', navigationId: 2 },
        nodes: [{ ref: 'a7', depth: 1, role: 'button', name: 'Save' }],
      }),
    });

    const result = await previewSnapshotTool.handler({}, ctx);

    expect(result.content).toContain('[ref=a7] button "Save"');
    expect(result.structuredData).toMatchObject({ page: { navigationId: 2 } });
  });
});

describe('preview bridge protocol', () => {
  it('uses operation-aware RPC ceilings', () => {
    expect(previewRpcTimeoutMs({ key: 'x', method: 'open' })).toBe(90_000);
    expect(previewRpcTimeoutMs({ key: 'x', method: 'network', args: { waitForMs: 30_000 } })).toBe(35_000);
    expect(previewRpcTimeoutMs({ key: 'x', method: 'eval', args: { timeoutMs: 8_000 } })).toBe(13_000);
  });

  it('isolates company preview keys by both company session and agent run', () => {
    const companyContext: CompanyContext = {
      orchestrator: {} as CompanyContext['orchestrator'],
      companySessionId: asCompanySessionId(
        '00000000-0000-4000-8000-000000000042',
      ),
      agentRole: 'preview-test',
      agentRunId: asAgentRunId(
        '00000000-0000-4000-8000-000000000009',
      ),
      allowedProjectIds: [],
      isMaster: false,
    };
    const companyCtx = {
      cwd: '/tmp',
      projectName: 'preview-test',
      companyContext,
    } satisfies ToolContext;
    expect(previewKey(companyCtx)).toBe(
      'company-session-00000000-0000-4000-8000-000000000042-' +
      'agent-00000000-0000-4000-8000-000000000009',
    );
  });

  it('propagates caller aborts to the backend request', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    setGlobalPreviewDevtools({
      invoke: () => new Promise(() => undefined),
      cancel,
    });
    const pending = invokePreview({ ...ctx, signal: controller.signal }, 'network', { waitForMs: 30_000 });

    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/i);
    expect(cancel).toHaveBeenCalledWith(expect.stringMatching(/^preview-/));
  });
});

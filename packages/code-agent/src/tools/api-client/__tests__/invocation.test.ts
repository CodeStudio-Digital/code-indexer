import { expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import type { ApiRequest } from '@mcp/store/api-client-types.js';
import { apiInvocation } from '../invocation.js';

it('rejects a saved request or environment edited while preparation was awaiting I/O', () => {
  const req = { id: 1, collection_id: 5, method: 'POST', path_template: '/initial' } as ApiRequest;
  const env = { id: 1, project_id: 7, base_url: 'http://localhost:3000', variables_json: '{}' };
  const store = { getRequest: () => req, getCollection: () => ({ project_id: 7 }), getDefaultEnvironment: () => env } as unknown as ApiClientStore;
  const ctx: ToolContext = { cwd: process.cwd(), projectName: 'fixture' };
  const bound = apiInvocation(ctx, { store, projectId: 7 }, [req], undefined);
  expect(() => bound.beforeDispatch(req)).not.toThrow();
  req.path_template = '/changed'; expect(() => bound.beforeDispatch(req)).toThrow('changed during');
  req.path_template = '/initial'; env.base_url = 'http://localhost:4000'; expect(() => bound.beforeDispatch(req)).toThrow('changed during');
});

it('checks cancellation and native ownership on every physical dispatch', () => {
  const req = { id: 1, collection_id: 5 } as ApiRequest;
  const store = { getRequest: () => req, getCollection: () => ({ project_id: 7 }), getDefaultEnvironment: () => null } as unknown as ApiClientStore;
  const assertCurrent = vi.fn(), controller = new AbortController();
  const ctx: ToolContext = { cwd: process.cwd(), projectName: 'fixture', signal: controller.signal,
    ports: { apiClient: { projectId: 7, assertCurrent, http: { send: vi.fn(), outcomeUnknown: vi.fn() } } } };
  const bound = apiInvocation(ctx, { store, projectId: 7 }, [req], undefined);
  bound.beforeDispatch(req); bound.beforeDispatch(req); expect(assertCurrent).toHaveBeenCalledTimes(2);
  controller.abort(new Error('lost attempt')); expect(() => bound.beforeDispatch(req)).toThrow('lost attempt');
});

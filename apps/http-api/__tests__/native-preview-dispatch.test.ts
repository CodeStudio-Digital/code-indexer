import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { authorizeNativePreviewDispatch } from '../native-preview-dispatch.js';
import { authorizeNativeApplicationDispatch } from '../native-application-dispatch.js';
const current = vi.hoisted(() => vi.fn());
vi.mock('../native-workspace-leases.js', () => ({ NativeWorkspaceLeaseStore: { verifier: () => ({ assertCurrentForMutation: current }) } }));
const lease = { leaseId: 'lease', ownerAgentRunId: 'owner', attemptId: 'attempt', access: 'exclusive_write',
  environmentId: 'env', environmentVersion: 1, version: 1, fencingEpoch: 1, root: 'D:/fixture', expiresAtUnixMs: Date.now() + 60_000 };
const config = { context: { sessionId: 'session', agentRunId: 'owner', attemptId: 'attempt' }, workspaceLeaseRoot: 'lease-root' } as any;
const store = { getAttemptState: vi.fn(async () => ({ attempt: { executorLease: { expiresAt: new Date(Date.now() + 60_000).toISOString() } } })),
  assertNativeWorkspaceLease: vi.fn(async () => undefined) } as any;
function request(input = { js: 'window.count++' }) {
  return { key: 'coder-session-attempt-attempt', method: 'eval', args: { js: 'FORGED' }, authority: { payload: { lease },
    toolUseId: 'tool', toolName: 'preview_eval', input,
    binding: { environmentId: 'env', environmentVersion: 1, workspaceLeaseId: 'lease', workspaceLeaseVersion: 1,
      workspaceFencingEpoch: 1, bindingId: 'effect:lease:tool', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      effectiveInputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      canonicalResources: [{ kind: 'application', appId: 'preview_eval', operations: ['preview/dispatch'] }] } } } as any;
}
beforeEach(() => vi.clearAllMocks());
it('uses only the sealed input and rechecks owner and durable lease at dispatch', async () => {
  const owner = vi.fn();
  const auth = await authorizeNativePreviewDispatch(request(), config, 1, store, owner);
  expect(auth.args).toEqual({ js: 'window.count++' });
  expect(store.assertNativeWorkspaceLease).toHaveBeenCalledWith(config.context, lease);
  owner.mockImplementation(() => { throw new Error('cancelled'); });
  expect(auth.assertDispatch).toThrow('cancelled');
});
it.each(['key', 'method', 'owner', 'input', 'tool', 'binding', 'resource', 'expiry', 'shared'])(
  'rejects forged or expired %s before dispatch', async field => {
    const req = request();
    if (field === 'key') req.key = 'coder-other';
    if (field === 'method') req.method = 'closeSessionPrefix';
    if (field === 'owner') req.authority.payload = { lease: { ...lease, attemptId: 'other' } };
    if (field === 'input') req.authority.input.js = 'different';
    if (field === 'tool') req.authority.toolName = 'preview_open';
    if (field === 'binding') req.authority.binding.bindingId += 'other';
    if (field === 'resource') req.authority.binding.canonicalResources[0].appId = 'preview_open';
    if (field === 'expiry') req.authority.binding.expiresAt = new Date(0).toISOString();
    if (field === 'shared') req.authority.payload.sharedLease = lease;
    await expect(authorizeNativePreviewDispatch(req, config, 1, store, () => {})).rejects.toThrow();
  });
it('rechecks durable revocation after authorization has completed', async () => {
  const auth = await authorizeNativePreviewDispatch(request(), config, 1, store, () => {});
  current.mockImplementationOnce(() => { throw new Error('revoked'); });
  expect(auth.assertDispatch).toThrow('revoked');
});
it.each(['valid', 'scope', 'operation', 'kind'])('database authority enforces the memory scope and operation: %s', async variant => {
  const req = request(); req.authority.toolName = 'remember';
  req.authority.binding.canonicalResources = [{ kind: 'database', databaseId: 'memory:project', operations: ['remember.save'] }];
  if (variant === 'scope') req.authority.binding.canonicalResources[0].databaseId = 'memory:user';
  if (variant === 'operation') req.authority.binding.canonicalResources[0].operations = ['forget_memory.archive'];
  if (variant === 'kind') req.authority.binding.canonicalResources[0].kind = 'application';
  const auth = authorizeNativeApplicationDispatch(req, config, { name: 'remember', key: req.key, operation: 'remember.save', databaseId: 'memory:project', args: {} }, store, () => {});
  if (variant === 'valid') await expect(auth).resolves.toHaveProperty('assertDispatch');
  else await expect(auth).rejects.toThrow('resource authority');
});

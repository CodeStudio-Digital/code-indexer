import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LspHandlerContext } from '../handler-context.js';

const overrideMocks = vi.hoisted(() => ({
  write: vi.fn(),
  list: vi.fn(() => []),
}));

vi.mock('../angular-profile-overrides.js', () => ({
  ANGULAR_LSP_FAMILY_ID: 'angular-language-server',
  listAngularProfileOverrides: overrideMocks.list,
  writeAngularProfileOverride: overrideMocks.write,
}));

import { createServerAdminHandlers } from '../server-admin-handlers.js';

describe('server admin handlers', () => {
  it('retires only the Angular facet affected by a profile override', async () => {
    const retireRoutes = vi.fn(async () => 1);
    const db = {} as LspHandlerContext['db'];
    const context = {
      db,
      lspManager: { retireRoutes },
      requireProjectRoot: () => 'C:\\repo',
    } as unknown as LspHandlerContext;
    const handlers = createServerAdminHandlers(context);

    await handlers.setAngularProfileOverride({
      projectId: 17,
      workspacePath: 'apps\\legacy',
      profileId: 'angular-12',
    }, {} as never);

    expect(overrideMocks.write).toHaveBeenCalledWith(
      db, 17, 'C:\\repo', 'apps\\legacy', 'angular-12',
    );
    expect(retireRoutes).toHaveBeenCalledWith(
      17,
      'angular-language-server',
      resolve('C:\\repo', 'apps\\legacy', 'package.json'),
    );
  });
});

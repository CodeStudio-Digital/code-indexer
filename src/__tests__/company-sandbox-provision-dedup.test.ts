import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the sandbox manager surface the provision path touches before it
// would await the container build. `provision` returns a never-resolving
// promise so the test stays entirely inside the in-flight-dedup guard.
const provisionSpy = vi.fn(() => new Promise(() => { /* never resolves */ }));
const subscribeSpy = vi.fn(() => () => undefined);

vi.mock('@mcp/services/sandbox/index.js', () => ({
  getSandboxManager: () => ({ subscribe: subscribeSpy, provision: provisionSpy, listServicesWithIds: () => [] }),
  resolveDriver: async () => ({}),
  archivePath: (id: string | number) => `/tmp/${id}.tar`,
}));

import { SandboxService } from '@mcp/company/services/SandboxService.js';

function makeService(): SandboxService {
  const ctx = {
    companySessionId: 42,
    projects: [{ project_id: 1 }],
    companyStore: {
      getCompanySession: () => ({ config_json: JSON.stringify({ builder: { stack: 'react-ts' } }) }),
    },
    db: { getProject: () => ({ project_id: 1, name: 'proj', root_path: '/work/proj' }) },
  } as never;
  const publisher = {} as never;
  return new SandboxService(ctx, publisher);
}

describe('SandboxService.provisionIfNeeded — in-flight dedup', () => {
  beforeEach(() => {
    provisionSpy.mockClear();
    subscribeSpy.mockClear();
  });

  it('two concurrent calls share a single container build', () => {
    const svc = makeService();
    // Fire both before either resolves — without the guard each would call
    // manager.provision, racing on the same sandboxId.
    void svc.provisionIfNeeded();
    void svc.provisionIfNeeded();
    expect(provisionSpy).toHaveBeenCalledTimes(1);
  });
});

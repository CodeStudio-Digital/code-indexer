import { describe, expect, it, vi } from 'vitest';
import { restartInstalledServerInstances } from '../restart-installed-server.js';

describe('restartInstalledServerInstances', () => {
  it('preserves each routed Angular workspace after an install', async () => {
    const restart = vi.fn(async () => undefined);
    const restartRoute = vi.fn(async () => true);
    const manager = {
      listInstances: () => [
        { projectId: 7, serverId: 'angular--v12', state: 'ready', routeId: 'route-v12' },
        { projectId: 7, serverId: 'angular--v12', state: 'ready', routeId: 'route-v12-b' },
        { projectId: 9, serverId: 'angular--v21', state: 'ready', routeId: 'route-v21' },
        { projectId: 8, serverId: 'angular--v12', state: 'ready' },
      ],
      restart,
      restartRoute,
    };

    await restartInstalledServerInstances(manager, 'angular--v12');

    expect(restartRoute.mock.calls).toEqual([[7, 'route-v12'], [7, 'route-v12-b']]);
    expect(restart).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith(8, 'angular--v12');
  });
});

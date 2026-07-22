interface RestartableServerManager {
  listInstances(): Array<{ projectId: number; serverId: string; routeId?: string }>;
  restart(projectId: number, serverId: string): Promise<unknown>;
  restartRoute(projectId: number, routeId: string): Promise<boolean>;
}

/** Restart only live instances that consume the newly installed artifact. */
export async function restartInstalledServerInstances(
  manager: RestartableServerManager,
  serverId: string,
): Promise<void> {
  const instances = manager.listInstances()
    .filter((instance) => instance.serverId === serverId);
  await Promise.allSettled(instances.map((instance) => instance.routeId
    ? manager.restartRoute(instance.projectId, instance.routeId)
    : manager.restart(instance.projectId, serverId)));
}

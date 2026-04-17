import { DashboardPanel } from '../panels/DashboardPanel';
import { ServerManager } from '../server/ServerManager';

export async function openChatCommand(serverManager: ServerManager, port: number): Promise<void> {
  await serverManager.ensureRunning();
  DashboardPanel.show(port);
}

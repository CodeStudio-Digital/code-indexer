import type { SshTunnel } from '@mcp/api-bus';
import { startPolling } from '../../../hooks/polling-controller.js';

/** Disposing an observer must neither update React nor restart its timer. */
export function startTunnelPolling(
  load: () => Promise<SshTunnel[]>,
  update: (list: SshTunnel[]) => void,
  poll: boolean,
  visibility: Parameters<typeof startPolling>[3] = document,
): () => void {
  let disposed = false;
  let delay = 1500;
  let lastSignature = '';
  const tick = async () => {
    try {
      const list = await load();
      if (disposed) return;
      update(list);
      const signature = list.map(x => `${x.id}:${x.bytesUp}:${x.bytesDown}`).join('|');
      delay = signature === lastSignature ? 5000 : 1500;
      lastSignature = signature;
    } catch { delay = 5000; }
  };
  // An empty panel discovers existing tunnels once. Start/stop actions refresh
  // explicitly; it does not need a recurring background request.
  if (!poll) {
    void tick();
    return () => { disposed = true; };
  }
  const stop = startPolling(tick, () => delay, false, visibility);
  return () => { disposed = true; stop(); };
}

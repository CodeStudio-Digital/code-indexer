export interface ElectronProcessMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
}

export interface WindowProcessDescriptor {
  pid: number;
  url: string;
  appWindow: boolean;
}

function safeWindowLabel(window: WindowProcessDescriptor): string {
  if (window.appWindow) return 'Dashboard';
  try {
    const url = new URL(window.url);
    const leaf = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (leaf.toLowerCase() === 'splash.html') return 'Splash';
    if (url.protocol === 'file:') return leaf ? `Window: ${leaf}` : 'Window';
    const location = `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname === '/' ? '' : url.pathname}`;
    return `Preview: ${location}`.slice(0, 160);
  } catch {
    return 'Window';
  }
}

/**
 * `app.getAppMetrics()` leaves renderer names blank on Windows. Join the
 * process tree with BrowserWindow/webContents metadata so perf captures can
 * distinguish the dashboard from previews without persisting query strings,
 * fragments or credentials.
 */
export function enrichElectronProcessMetrics<T extends ElectronProcessMetric>(
  metrics: T[],
  windows: WindowProcessDescriptor[],
): Array<T & { name?: string }> {
  const labelByPid = new Map<number, string>();
  for (const window of windows) {
    if (!Number.isInteger(window.pid) || window.pid <= 0) continue;
    const label = safeWindowLabel(window);
    const existing = labelByPid.get(window.pid);
    // A shared renderer process should retain the authoritative app label.
    if (!existing || label === 'Dashboard') labelByPid.set(window.pid, label);
  }

  return metrics.map((metric) => {
    if (metric.name || metric.serviceName) return metric;
    const name = metric.type === 'Browser' ? 'Electron main' : labelByPid.get(metric.pid);
    return name ? { ...metric, name } : metric;
  });
}

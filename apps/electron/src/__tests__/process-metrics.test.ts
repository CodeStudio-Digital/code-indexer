import { describe, expect, it } from 'vitest';
import { enrichElectronProcessMetrics } from '../process-metrics.js';

describe('enrichElectronProcessMetrics', () => {
  it('labels the main process and joins renderer PIDs to their surfaces', () => {
    const metrics = enrichElectronProcessMetrics(
      [
        { pid: 1, type: 'Browser' },
        { pid: 2, type: 'Tab' },
        { pid: 3, type: 'Tab' },
      ],
      [
        { pid: 2, url: 'http://localhost:7317/project/4?token=secret#selection', appWindow: true },
        { pid: 3, url: 'http://localhost:4173/preview?token=secret', appWindow: false },
      ],
    );

    expect(metrics).toEqual([
      { pid: 1, type: 'Browser', name: 'Electron main' },
      { pid: 2, type: 'Tab', name: 'Dashboard' },
      { pid: 3, type: 'Tab', name: 'Preview: localhost:4173/preview' },
    ]);
  });

  it('preserves native service names and gives Dashboard priority for shared PIDs', () => {
    const metrics = enrichElectronProcessMetrics(
      [
        { pid: 4, type: 'Utility', serviceName: 'Network Service' },
        { pid: 5, type: 'Tab' },
      ],
      [
        { pid: 5, url: 'file:///D:/MCP/apps/electron/splash.html', appWindow: false },
        { pid: 5, url: 'mcp://app/project/9', appWindow: true },
      ],
    );

    expect(metrics[0]).toEqual({ pid: 4, type: 'Utility', serviceName: 'Network Service' });
    expect(metrics[1]?.name).toBe('Dashboard');
  });
});

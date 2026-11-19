import { app } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrowserContext, BrowserContextOptions } from 'playwright-core';
import type { ResearchBrowserContext, ResearchBrowserHost } from '@mcp/services/research-browser/types.js';

export function createElectronBrowserHost(): ResearchBrowserHost & { dispose(): Promise<void> } {
  const pending = new Set<Promise<ResearchBrowserContext>>();
  const active = new Set<() => Promise<void>>();
  let disposed = false;

  async function launch(options?: BrowserContextOptions): Promise<ResearchBrowserContext> {
    const base = resolve(tmpdir());
    const profile = await mkdtemp(join(base, 'codestudio-chromium-'));
    let context: BrowserContext | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      try {
        await context?.close();
      } finally {
        active.delete(close);
        if (dirname(profile) === base && basename(profile).startsWith('codestudio-chromium-')) {
          await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {});
        }
      }
    })();

    try {
      const { chromium } = await import('playwright-core');
      const entry = app.isPackaged ? [] : [app.getAppPath()];
      context = await chromium.launchPersistentContext(profile, {
        ...options,
        executablePath: process.execPath,
        ignoreDefaultArgs: true,
        args: [
          '--remote-debugging-pipe',
          '--user-data-dir=' + profile,
          '--disable-background-networking',
          '--codestudio-browser-worker',
          ...entry,
        ],
        chromiumSandbox: true,
        timeout: 25_000,
      });
      const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 5_000 });
      if (disposed) throw new Error('Electron browser is shutting down.');
      active.add(close);
      return {
        // Electron exposes the host-created BrowserWindow over the pipe.
        newPage: async () => page,
        route: context.route.bind(context),
        routeWebSocket: context.routeWebSocket.bind(context),
        on: context.on.bind(context),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    async newContext(options) {
      if (disposed) throw new Error('Electron browser is shutting down.');
      const opened = launch(options);
      pending.add(opened);
      try { return await opened; } finally { pending.delete(opened); }
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled(pending);
      await Promise.allSettled([...active].map(close => close()));
    },
  };
}

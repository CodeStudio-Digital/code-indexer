import type { BrowserWindow, WebContents } from 'electron';

/** Only the dashboard document may replace a dashboard window; routes live in its hash. */
export function isAppDocument(rawUrl: string, appUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const app = new URL(appUrl);
    url.hash = '';
    app.hash = '';
    return url.href === app.href;
  } catch { return false; }
}

export function isBrowserLink(rawUrl: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(rawUrl).protocol); }
  catch { return false; }
}

export function isDocumentLink(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'file:' || (url.protocol === 'mcp:' && url.hostname === 'app')
      || /^data:(?:application\/pdf|text\/plain|image\/(?:png|jpeg|gif|webp));/i.test(rawUrl);
  } catch { return false; }
}

function isPreviewPopup(url: string, features: string): boolean {
  try {
    const parsed = new URL(url);
    return /(?:^|,)\s*newWindow=yes\s*(?:,|$)/i.test(features)
      && ['http:', 'https:'].includes(parsed.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

interface NavigationOptions {
  appUrl: string;
  openExternal(url: string): void;
  openDocument(url: string): void;
  openAppRoute(route: string): void;
  onPreviewCreated?(win: BrowserWindow): void;
}

/** HTTP links, including localhost, never take over the IDE. */
export function installWindowNavigation(contents: WebContents, options: NavigationOptions): void {
  const openLink = (url: string): void => {
    if (isBrowserLink(url)) options.openExternal(url);
    else if (isDocumentLink(url)) options.openDocument(url);
  };
  contents.setWindowOpenHandler(({ url, features }) => {
    if (isAppDocument(url, options.appUrl)) {
      options.openAppRoute(new URL(url).hash.slice(1));
    } else if (isPreviewPopup(url, features)) {
      // Explicit builder popouts keep their window handle, without the app bridge.
      return { action: 'allow', overrideBrowserWindowOptions: {
        webPreferences: { preload: '', sandbox: true, contextIsolation: true, nodeIntegration: false },
      } };
    } else openLink(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isAppDocument(url, options.appUrl)) return;
    event.preventDefault();
    openLink(url);
  });
  contents.on('will-redirect', (event, url, _sameDocument, isMainFrame) => {
    if (!isMainFrame || isAppDocument(url, options.appUrl)) return;
    event.preventDefault();
    openLink(url);
  });
  contents.on('did-create-window', (child, details) => {
    // A preview may navigate within its own origin, but cannot load the IDE bridge.
    const origin = new URL(details.url).origin;
    child.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
    const guard = (event: { preventDefault(): void }, url: string): void => {
      try { if (new URL(url).origin === origin) return; } catch { /* reject malformed URLs */ }
      event.preventDefault();
      openLink(url);
    };
    child.webContents.on('will-navigate', guard);
    child.webContents.on('will-redirect', (event, url, _sameDocument, main) => { if (main) guard(event, url); });
    options.onPreviewCreated?.(child);
  });
}

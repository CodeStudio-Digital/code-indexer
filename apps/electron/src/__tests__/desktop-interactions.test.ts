import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { isAppDocument, installWindowNavigation } from '../window-navigation.js';
import { allowRendererPermission } from '../renderer-permissions.js';
import { isDevtoolsChord } from '../security-hardening.js';

vi.mock('electron', () => ({ app: { isPackaged: true }, ipcMain: {}, Menu: {}, session: {} }));

const appUrl = 'file:///C:/CodeStudio/dashboard/index.html';

describe('desktop document navigation', () => {
  it('allows dashboard hash routes, not arbitrary files or localhost sites', () => {
    expect(isAppDocument(`${appUrl}#/projects/42`, appUrl)).toBe(true);
    for (const url of ['file:///C:/report.html', 'mcp://app/api/files', 'http://localhost:3000', 'about:blank']) {
      expect(isAppDocument(url, appUrl)).toBe(false);
    }
    expect(isAppDocument('http://localhost:7317.evil.test/', 'http://localhost:7317/')).toBe(false);
    expect(isAppDocument('http://localhost:7317/report', 'http://localhost:7317/')).toBe(false);
  });

  function fixture() {
    const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
    const options = { appUrl, openExternal: vi.fn(), openDocument: vi.fn(), openAppRoute: vi.fn() };
    installWindowNavigation(contents as unknown as WebContents, options);
    return { contents, options, popup: contents.setWindowOpenHandler.mock.calls[0]![0] };
  }

  it.each(['https://example.org/help', 'http://localhost:3000/', 'http://127.0.0.1:7333/report'])('opens %s externally without replacing the IDE', url => {
    const { contents, options, popup } = fixture();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, url);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(options.openExternal).toHaveBeenCalledWith(url);
    expect(popup({ url, features: 'noopener' })).toEqual({ action: 'deny' });
  });

  it('protects main-frame redirects without intercepting preview iframe redirects', () => {
    const { contents, options } = fixture();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-redirect', event, 'https://example.org', false, false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    contents.emit('will-redirect', event, 'https://example.org', false, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(options.openExternal).toHaveBeenCalledOnce();
  });

  it('retains explicit builder popouts with no preload and blocks arbitrary schemes', () => {
    const { popup, options } = fixture();
    expect(popup({ url: 'http://localhost:3000/', features: 'newWindow=yes' })).toMatchObject({
      action: 'allow', overrideBrowserWindowOptions: { webPreferences: { preload: '', sandbox: true, nodeIntegration: false } },
    });
    for (const url of ['javascript:alert(1)', 'ms-settings:privacy', 'about:blank']) {
      expect(popup({ url, features: '' })).toEqual({ action: 'deny' });
    }
    expect(options.openExternal).not.toHaveBeenCalled();
  });

  it('routes documents and app popouts separately from the current page', () => {
    const { contents, popup, options } = fixture();
    const event = { preventDefault: vi.fn() };
    contents.emit('will-navigate', event, 'file:///C:/report.pdf');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(options.openDocument).toHaveBeenCalledWith('file:///C:/report.pdf');
    popup({ url: `${appUrl}#/projects/42`, features: 'noopener' });
    expect(options.openAppRoute).toHaveBeenCalledWith('/projects/42');
  });
});

describe('desktop clipboard and shortcuts', () => {
  it.each(['clipboard-read', 'clipboard-sanitized-write'])('grants %s only to the trusted top frame', permission => {
    const details = { isMainFrame: true, requestingUrl: `${appUrl}#/chat` };
    expect(allowRendererPermission(permission, appUrl, appUrl, details)).toBe(true);
    expect(allowRendererPermission(permission, appUrl, appUrl, { ...details, isMainFrame: false })).toBe(false);
    expect(allowRendererPermission(permission, 'http://localhost:3000/', appUrl, details)).toBe(false);
    expect(allowRendererPermission(permission, appUrl, appUrl, { ...details, requestingUrl: 'file:///C:/other.html' })).toBe(false);
  });

  it('preserves audio dictation while denying camera and unrelated permissions', () => {
    const details = { isMainFrame: true, requestingUrl: appUrl };
    expect(allowRendererPermission('media', appUrl, appUrl, { ...details, mediaTypes: ['audio'] })).toBe(true);
    expect(allowRendererPermission('media', appUrl, appUrl, { ...details, mediaTypes: ['video'] })).toBe(false);
    expect(allowRendererPermission('geolocation', appUrl, appUrl, details)).toBe(false);
  });

  it('does not swallow terminal copy but still blocks DevTools shortcuts', () => {
    const input = { type: 'keyDown', control: true, shift: true, key: 'c' } as Electron.Input;
    expect(isDevtoolsChord(input)).toBe(false);
    expect(isDevtoolsChord({ ...input, key: 'v' })).toBe(false);
    expect(isDevtoolsChord({ ...input, key: 'i' })).toBe(true);
    expect(isDevtoolsChord({ ...input, key: 'F12' })).toBe(true);
  });
});

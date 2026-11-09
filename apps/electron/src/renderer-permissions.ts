import type { Session } from 'electron';
import { isAppDocument } from './window-navigation.js';

export function allowRendererPermission(permission: string, topUrl: string, appUrl: string,
  details: { isMainFrame: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
  if (!details.isMainFrame || !isAppDocument(topUrl, appUrl)) return false;
  if (details.requestingUrl && !isAppDocument(details.requestingUrl, appUrl)) return false;
  if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') return true;
  if (permission !== 'media' && permission !== 'audioCapture') return false;
  return details.mediaType !== 'video' && !details.mediaTypes?.includes('video');
}

/** Grant clipboard access only to the IDE's top frame, never a project preview. */
export function installRendererPermissions(session: Session, appUrl: string): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowRendererPermission(permission, contents?.getURL() ?? '', appUrl, details));
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    return allowRendererPermission(permission, contents?.getURL() ?? '', appUrl, details);
  });
}

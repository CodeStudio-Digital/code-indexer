import { toast } from '../../components/ui/prompt-dialog.js';
import type {
  AppNotificationEvent,
  DesktopNotificationOptions,
  NotificationEvent,
  NotificationRouteTarget,
  NotificationSeverity,
} from './types.js';

const SETTINGS_TTL_MS = 30_000;
const DEDUPE_TTL_MS = 30 * 60_000;
const DEDUPE_PREFIX = 'mcp.desktop-notification';

interface NotificationSettings {
  enabled: boolean;
  actionRequired: boolean;
  sessionFinished: boolean;
}

interface SettingsResponse {
  items?: Array<{ key?: string; value?: string | null; default?: string | null }>;
}

export interface RouteVisibilitySnapshot {
  pathname: string;
  search?: string;
  visibilityState?: DocumentVisibilityState | 'visible' | 'hidden' | 'prerender' | 'unloaded';
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  actionRequired: true,
  sessionFinished: true,
};

const memoryDedupe = new Map<string, number>();
let settingsCache: { value: NotificationSettings; expiresAt: number } | null = null;
let nativeSupportCache: { value: boolean; expiresAt: number } | null = null;

export function buildNotificationKey(event: AppNotificationEvent): string {
  if (event.dedupeKey) return `${DEDUPE_PREFIX}:${event.dedupeKey}`;
  const scope = event.target.scopeId ?? event.target.kind;
  const session = event.target.sessionId ?? 'no-session';
  return [
    DEDUPE_PREFIX,
    event.kind,
    event.target.kind,
    String(scope),
    String(session),
    event.id,
  ].join(':');
}

export function resetNotificationRuntimeForTests(): void {
  memoryDedupe.clear();
  settingsCache = null;
  nativeSupportCache = null;
}

export function isNotificationRouteVisible(target: NotificationRouteTarget): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  return isNotificationRouteVisibleForLocation(target, {
    pathname: window.location.pathname,
    search: window.location.search,
    visibilityState: document.visibilityState,
  });
}

export function isNotificationRouteVisibleForLocation(
  target: NotificationRouteTarget,
  snapshot: RouteVisibilitySnapshot,
): boolean {
  if (snapshot.visibilityState !== 'visible') return false;

  const targetRoute = parseRoute(target.route);
  if (!targetRoute) return false;
  const pathname = normalizePath(snapshot.pathname);
  const search = snapshot.search ?? '';

  if (target.kind === 'project') {
    const match = /^\/projects\/([^/?#]+)/.exec(pathname);
    if (!match) return false;
    if (target.scopeId != null && decodeURIComponent(match[1]) !== String(target.scopeId)) {
      return false;
    }
    return sessionMatches(search, target.sessionId);
  }

  if (target.kind === 'global') {
    if (pathname !== '/global') return false;
    return sessionMatches(search, target.sessionId);
  }

  if (target.kind === 'company') {
    if (pathname !== targetRoute.pathname) return false;
    if (target.scopeId != null) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] !== 'company' || parts[1] !== 'sessions' || parts[2] !== String(target.scopeId)) {
        return false;
      }
    }
    return true;
  }

  return pathname === targetRoute.pathname && searchIncludesTarget(search, targetRoute.search);
}

export async function emitAppNotification(event: AppNotificationEvent): Promise<void> {
  if (typeof window === 'undefined') return;

  const settings = await resolveNotificationSettings();
  if (!isEnabledForKind(settings, event.kind)) return;

  const key = buildNotificationKey(event);
  if (markDuplicate(key)) return;
  if (isNotificationRouteVisible(event.target)) return;

  const payload: DesktopNotificationOptions = {
    title: event.title,
    body: event.body,
    route: event.target.route,
    tag: key,
    kind: event.kind,
  };

  const bridge = window.electronAPI;
  const canUseNative = !!bridge?.showNotification && await resolveNativeNotificationSupport(bridge);
  if (canUseNative) {
    bridge.showNotification(payload);
    return;
  }

  showToastFallback(event.severity ?? (event.kind === 'human_action_required' ? 'warning' : 'info'), event);
}

type NotificationSource = (emit: typeof emitAppNotification) => void | (() => void);

const registeredSources = new Map<string, () => void>();

export function registerNotificationSource(name: string, source: NotificationSource): () => void {
  registeredSources.get(name)?.();
  const cleanup = source(emitAppNotification);
  const dispose = typeof cleanup === 'function' ? cleanup : () => undefined;
  registeredSources.set(name, dispose);
  return () => {
    if (registeredSources.get(name) === dispose) {
      registeredSources.delete(name);
    }
    dispose();
  };
}

function isEnabledForKind(settings: NotificationSettings, kind: NotificationEvent): boolean {
  if (!settings.enabled) return false;
  if (kind === 'human_action_required') return settings.actionRequired;
  if (kind === 'session_finished') return settings.sessionFinished;
  return true;
}

async function resolveNotificationSettings(): Promise<NotificationSettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value;

  try {
    const res = await fetch('/api/admin/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as SettingsResponse;
    const value = settingsFromResponse(body);
    settingsCache = { value, expiresAt: now + SETTINGS_TTL_MS };
    return value;
  } catch {
    settingsCache = { value: DEFAULT_SETTINGS, expiresAt: now + SETTINGS_TTL_MS };
    return DEFAULT_SETTINGS;
  }
}

export function settingsFromResponse(body: SettingsResponse): NotificationSettings {
  const itemByKey = new Map<string, { value?: string | null; default?: string | null }>();
  for (const item of body.items ?? []) {
    if (typeof item.key === 'string') itemByKey.set(item.key, item);
  }
  return {
    enabled: readBool(itemByKey.get('MCP_DESKTOP_NOTIFICATIONS_ENABLED'), DEFAULT_SETTINGS.enabled),
    actionRequired: readBool(itemByKey.get('MCP_DESKTOP_NOTIFY_ACTION_REQUIRED'), DEFAULT_SETTINGS.actionRequired),
    sessionFinished: readBool(itemByKey.get('MCP_DESKTOP_NOTIFY_SESSION_FINISHED'), DEFAULT_SETTINGS.sessionFinished),
  };
}

async function resolveNativeNotificationSupport(bridge: NonNullable<Window['electronAPI']>): Promise<boolean> {
  const checker = bridge.isNotificationSupported;
  if (!checker) return true;
  const now = Date.now();
  if (nativeSupportCache && nativeSupportCache.expiresAt > now) return nativeSupportCache.value;
  try {
    const value = await checker();
    nativeSupportCache = { value, expiresAt: now + SETTINGS_TTL_MS };
    return value;
  } catch {
    return false;
  }
}

function readBool(item: { value?: string | null; default?: string | null } | undefined, fallback: boolean): boolean {
  if (!item) return fallback;
  const raw = item.value ?? item.default;
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function markDuplicate(key: string, now = Date.now()): boolean {
  const existing = memoryDedupe.get(key);
  if (existing != null && now - existing < DEDUPE_TTL_MS) return true;
  if (seenInSessionStorage(key, now)) return true;

  memoryDedupe.set(key, now);
  try {
    window.sessionStorage.setItem(key, String(now));
  } catch {
    /* ignore storage failures */
  }
  return false;
}

function seenInSessionStorage(key: string, now: number): boolean {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts) || now - ts >= DEDUPE_TTL_MS) {
      window.sessionStorage.removeItem(key);
      return false;
    }
    memoryDedupe.set(key, ts);
    return true;
  } catch {
    return false;
  }
}

function showToastFallback(severity: NotificationSeverity, event: AppNotificationEvent): void {
  const opts = { description: event.body };
  if (severity === 'error') toast.error(event.title, opts);
  else if (severity === 'warning') toast.warning(event.title, opts);
  else toast.info(event.title, opts);
}

function sessionMatches(search: string, sessionId: NotificationRouteTarget['sessionId']): boolean {
  if (sessionId == null) return true;
  return new URLSearchParams(search).get('session') === String(sessionId);
}

function searchIncludesTarget(search: string, targetSearch: string): boolean {
  if (!targetSearch) return true;
  const current = new URLSearchParams(search);
  const target = new URLSearchParams(targetSearch);
  for (const [key, value] of target.entries()) {
    if (current.get(key) !== value) return false;
  }
  return true;
}

function parseRoute(route: string): { pathname: string; search: string } | null {
  try {
    const url = new URL(route, 'http://mcp.local');
    return { pathname: normalizePath(url.pathname), search: url.search };
  } catch {
    return null;
  }
}

function normalizePath(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

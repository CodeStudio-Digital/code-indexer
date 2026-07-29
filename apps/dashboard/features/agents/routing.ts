/**
 * URL routing for the company-mode dashboard.
 *
 * Canonical shape: `/company/sessions/:rootId/:frontId/:zone/:tab`.
 *   - rootId  — the root `CompanySession.id` (the "Main" tab).
 *   - frontId — `rootId` to point at Main, or a child session id.
 *               String `"main"` is also accepted as an alias for the root.
 *   - zone    — one of `Zone` (`work` | `build` | `data`).
 *   - tab     — one of the inner tabs for the chosen zone.
 *
 * Aliases and short forms are normalized on parse so deep links survive
 * future tab renames: an unknown `tab` falls back to the zone's default,
 * and an unknown `zone` falls back to `work`.
 */
import {
  DEFAULT_TAB_FOR_ZONE,
  ZONES,
  findZoneForTab,
  isValidTab,
  type Zone,
} from './zones/types.js';

export const AGENTS_ROOT = '/agents';

export interface AgentsRoute {
  rootId: string;
  frontId: string;
  zone: Zone;
  tab: string;
}

const FRONT_MAIN_ALIAS = 'main';

/**
 * Build the canonical URL for `(rootId, frontId, zone, tab)`. Pass
 * `frontId === rootId` (or `'main'`) to land on the Main tab.
 */
export function buildAgentsUrl(
  rootId: string,
  frontId: string | 'main',
  zone: Zone,
  tab: string,
): string {
  const front = frontId === 'main' || frontId === rootId ? FRONT_MAIN_ALIAS : String(frontId);
  return `/company/sessions/${rootId}/${front}/${zone}/${tab}`;
}

/**
 * Default destination for a session — used by the session-list sidebar
 * when no front/zone/tab is selected yet.
 */
export function buildAgentsDefaultUrl(rootId: string): string {
  return buildAgentsUrl(rootId, 'main', 'work', DEFAULT_TAB_FOR_ZONE.work);
}

interface RawParams {
  rootId?: string;
  frontId?: string;
  zone?: string;
  tab?: string;
}

/**
 * Parse params produced by react-router's `useParams<...>()`. Returns
 * `null` if `rootId` is missing or blank. IDs are opaque UUID strings;
 * parsing must never coerce them to numbers. The other segments are
 * normalized — bad values fall back to safe defaults rather than 404ing
 * the user. The caller can detect "redirect needed" by comparing the
 * returned route to the URL it parsed.
 */
export function parseAgentsParams(params: RawParams, rootIdFallback?: string): AgentsRoute | null {
  const rawRoot = params.rootId;
  const rootId = rawRoot?.trim() || rootIdFallback;
  if (!rootId) return null;

  const frontRaw = params.frontId;
  const frontId =
    frontRaw == null || frontRaw === FRONT_MAIN_ALIAS
      ? rootId
      : frontRaw.trim();
  const resolvedFront = frontId || rootId;

  const zoneRaw = (params.zone ?? '').toLowerCase();
  const zone: Zone = (ZONES as readonly string[]).includes(zoneRaw)
    ? (zoneRaw as Zone)
    : 'work';

  const tabRaw = params.tab ?? '';
  // If the requested tab doesn't belong to the requested zone, route to
  // the canonical zone for that tab when possible (e.g. user hand-types
  // /work/drive — Drive lives in Data, so redirect there).
  let tab = tabRaw;
  let resolvedZone = zone;
  if (!isValidTab(zone, tab)) {
    const detected = findZoneForTab(tab);
    if (detected) {
      resolvedZone = detected;
    } else {
      tab = DEFAULT_TAB_FOR_ZONE[zone];
    }
  }

  return { rootId, frontId: resolvedFront, zone: resolvedZone, tab };
}

/**
 * True when the URL produced by `parseAgentsParams` doesn't match its
 * raw input — i.e. one or more segments were normalized away and the
 * router should redirect to the canonical form.
 */
export function shouldRedirectAgentsUrl(params: RawParams, parsed: AgentsRoute): boolean {
  const canonical = buildAgentsUrl(parsed.rootId, parsed.frontId, parsed.zone, parsed.tab);
  const raw = `/company/sessions/${params.rootId}/${params.frontId ?? FRONT_MAIN_ALIAS}/${params.zone ?? ''}/${params.tab ?? ''}`;
  return canonical !== raw;
}

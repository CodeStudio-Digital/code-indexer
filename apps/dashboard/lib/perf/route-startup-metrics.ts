type RouteMetricStatus = 'ok' | 'error' | 'pending';

export interface RouteMetricMeta {
  projectId?: number;
  tab?: string;
  source?: string;
  detail?: string;
  url?: string;
  status?: RouteMetricStatus;
  error?: string;
  cache?: 'hit' | 'miss';
  phase?: string;
  [key: string]: unknown;
}

export interface RouteMetricEvent {
  id: number;
  name: string;
  atMs: number;
  route: string;
  projectId?: number;
  tab?: string;
  meta?: RouteMetricMeta;
}

export interface RouteMetricSpan {
  id: number;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  route: string;
  projectId?: number;
  tab?: string;
  status: RouteMetricStatus;
  meta?: RouteMetricMeta;
}

export interface RouteMetricVital {
  id: number;
  name: 'FCP' | 'LCP' | 'CLS' | 'longtask';
  atMs: number;
  durationMs?: number;
  value?: number;
  route: string;
  projectId?: number;
  tab?: string;
  selector?: string;
  text?: string;
  width?: number;
  height?: number;
  meta?: RouteMetricMeta;
}

export interface RouteStartupSample {
  id: number;
  route: string;
  projectId?: number;
  tab?: string;
  startedAt: number;
  startTimeMs: number;
  events: RouteMetricEvent[];
  spans: RouteMetricSpan[];
  vitals: RouteMetricVital[];
  fcpMs?: number;
  lcp?: RouteMetricVital;
  cls: number;
}

export interface RouteStartupSnapshot {
  current?: RouteStartupSample;
  samples: RouteStartupSample[];
  generatedAt: number;
}

type MutableRouteStartupSample = RouteStartupSample & {
  onceKeys: Set<string>;
};

type LcpEntry = PerformanceEntry & {
  element?: Element;
  renderTime?: number;
  loadTime?: number;
  size?: number;
  url?: string;
};

type LayoutShiftEntry = PerformanceEntry & {
  hadRecentInput?: boolean;
  value?: number;
};

const MAX_SAMPLES = 10;
const MAX_EVENTS = 300;
const MAX_SPANS = 300;
const MAX_VITALS = 160;
const PROJECT_ROUTE = '/projects/:id';

let started = false;
let current: MutableRouteStartupSample | undefined;
let nextRouteId = 1;
let nextEventId = 1;
let samples: MutableRouteStartupSample[] = [];

// Collection is OFF by default. In a normal session nobody reads route-startup
// telemetry, so the per-`apiCall`/`useApi` span wrapping and the 4 always-on
// PerformanceObservers are pure overhead. The admin RouteStartupPanel
// ref-counts collection ON only while it is mounted (see
// `acquireRouteMetricsCollection`). While OFF every recorder below short-circuits.
let collectionEnabled = false;
let collectionRefs = 0;
const activeObservers: PerformanceObserver[] = [];

function perfNow(): number {
  if (typeof performance === 'undefined') {
    return Date.now();
  }
  return performance.now();
}

function safeNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function limitPush<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function stripMutable(sample: MutableRouteStartupSample): RouteStartupSample {
  return {
    id: sample.id,
    route: sample.route,
    projectId: sample.projectId,
    tab: sample.tab,
    startedAt: sample.startedAt,
    startTimeMs: sample.startTimeMs,
    events: [...sample.events],
    spans: [...sample.spans],
    vitals: [...sample.vitals],
    fcpMs: sample.fcpMs,
    lcp: sample.lcp,
    cls: sample.cls,
  };
}

function routeSampleFor(projectId?: number): MutableRouteStartupSample | undefined {
  if (!collectionEnabled || !current) {
    return undefined;
  }
  if (
    typeof projectId === 'number' &&
    typeof current.projectId === 'number' &&
    current.projectId !== projectId
  ) {
    return undefined;
  }
  return current;
}

function routeOffset(sample: MutableRouteStartupSample, time = perfNow()): number {
  return rounded(Math.max(0, time - sample.startTimeMs));
}

function sanitizeText(text: string | undefined | null, max = 90): string | undefined {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function sanitizeToken(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function selectorFor(element?: Element): string | undefined {
  if (!element) {
    return undefined;
  }
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${sanitizeToken(element.id)}` : '';
  const classes = Array.from(element.classList ?? [])
    .slice(0, 4)
    .map((klass) => `.${sanitizeToken(klass)}`)
    .join('');
  return `${tag}${id}${classes}`;
}

function parseProjectId(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://local');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.slice(0, 180);
  }
}

function includeFilesModeFromInput(input: unknown): 'summary' | 'full' {
  if (input && typeof input === 'object' && 'includeFiles' in input) {
    return (input as { includeFiles?: boolean }).includeFiles === false ? 'summary' : 'full';
  }
  return 'full';
}

function newSample(projectId: number, tab?: string, startTimeMs = perfNow()): MutableRouteStartupSample {
  const sample: MutableRouteStartupSample = {
    id: nextRouteId++,
    route: PROJECT_ROUTE,
    projectId,
    tab,
    startedAt: Date.now(),
    startTimeMs,
    events: [],
    spans: [],
    vitals: [],
    cls: 0,
    onceKeys: new Set(),
  };
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) {
    samples = samples.slice(-MAX_SAMPLES);
  }
  current = sample;
  return sample;
}

function ensureRouteStartupMetrics(): void {
  if (started || typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') {
    return;
  }
  started = true;

  observePerformanceType('paint', (entry) => {
    if (entry.name !== 'first-contentful-paint') {
      return;
    }
    const sample = routeSampleFor();
    if (!sample || sample.fcpMs !== undefined) {
      return;
    }
    const atMs = routeOffset(sample, entry.startTime);
    sample.fcpMs = atMs;
    addVital(sample, {
      name: 'FCP',
      atMs,
      value: atMs,
    });
  });

  observePerformanceType('largest-contentful-paint', (entry) => {
    const sample = routeSampleFor();
    if (!sample) {
      return;
    }
    const lcp = entry as LcpEntry;
    const element = lcp.element;
    const rect = element?.getBoundingClientRect();
    const atMs = routeOffset(sample, lcp.renderTime || lcp.loadTime || lcp.startTime);
    const vital = addVital(sample, {
      name: 'LCP',
      atMs,
      value: atMs,
      selector: selectorFor(element),
      text: sanitizeText(element?.textContent),
      width: safeNumber(rect?.width),
      height: safeNumber(rect?.height),
      meta: {
        size: lcp.size,
        url: lcp.url ? safeUrl(lcp.url) : undefined,
      },
    });
    sample.lcp = vital;
  });

  observePerformanceType('layout-shift', (entry) => {
    const sample = routeSampleFor();
    const layoutShift = entry as LayoutShiftEntry;
    if (!sample || layoutShift.hadRecentInput) {
      return;
    }
    sample.cls = rounded(sample.cls + (layoutShift.value ?? 0));
    addVital(sample, {
      name: 'CLS',
      atMs: routeOffset(sample, entry.startTime),
      value: sample.cls,
    });
  });

  observePerformanceType('longtask', (entry) => {
    const sample = routeSampleFor();
    if (!sample) {
      return;
    }
    addVital(sample, {
      name: 'longtask',
      atMs: routeOffset(sample, entry.startTime),
      durationMs: rounded(entry.duration),
      value: rounded(entry.duration),
      meta: {
        entryName: entry.name,
      },
    });
  });
}

function observePerformanceType(
  type: 'paint' | 'largest-contentful-paint' | 'layout-shift' | 'longtask',
  callback: (entry: PerformanceEntry) => void,
): void {
  try {
    const supported = PerformanceObserver.supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes(type)) {
      return;
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        callback(entry);
      }
    });
    observer.observe({ type, buffered: true } as PerformanceObserverInit);
    activeObservers.push(observer);
  } catch {
    // Optional browser metrics should never affect the app itself.
  }
}

/**
 * Turn route-metrics collection on while a perf panel is mounted. Ref-counted
 * so multiple holders can share it; the returned disposer releases one hold and
 * tears the observers down when the last holder unmounts. `buffered: true` means
 * paint/LCP/CLS/longtask entries from the initial page load are still replayed
 * when collection starts later, so the panel sees startup history.
 */
export function acquireRouteMetricsCollection(): () => void {
  collectionRefs += 1;
  if (collectionRefs === 1) {
    collectionEnabled = true;
    ensureRouteStartupMetrics();
    startInitialProjectRouteFromLocation();
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    collectionRefs = Math.max(0, collectionRefs - 1);
    if (collectionRefs === 0) {
      collectionEnabled = false;
      stopRouteStartupMetrics();
      current = undefined;
    }
  };
}

/** Disconnect the route-startup PerformanceObservers (best-effort). */
function stopRouteStartupMetrics(): void {
  for (const observer of activeObservers) {
    try {
      observer.disconnect();
    } catch {
      // disconnect is best-effort.
    }
  }
  activeObservers.length = 0;
  started = false;
}

function isRouteMetricsCollecting(): boolean {
  return collectionEnabled;
}

function addVital(
  sample: MutableRouteStartupSample,
  vital: Omit<RouteMetricVital, 'id' | 'route' | 'projectId' | 'tab'>,
): RouteMetricVital {
  const row: RouteMetricVital = {
    id: nextEventId++,
    route: sample.route,
    projectId: sample.projectId,
    tab: sample.tab,
    ...vital,
  };
  limitPush(sample.vitals, row, MAX_VITALS);
  return row;
}

function startInitialProjectRouteFromLocation(): void {
  if (typeof window === 'undefined') {
    return;
  }
  const match = window.location.pathname.match(/^\/projects\/(\d+)/);
  if (!match) {
    return;
  }
  const projectId = Number(match[1]);
  if (!Number.isFinite(projectId)) {
    return;
  }
  startProjectRoute(projectId, {
    source: 'initial-location',
    startTimeMs: 0,
  });
}

export function startProjectRoute(
  projectId: number,
  options: { tab?: string; source?: string; startTimeMs?: number } = {},
): void {
  if (!collectionEnabled || !Number.isFinite(projectId)) {
    return;
  }
  if (current?.route === PROJECT_ROUTE && current.projectId === projectId) {
    if (options.tab) {
      current.tab = options.tab;
    }
    return;
  }

  const sample = newSample(projectId, options.tab, options.startTimeMs ?? perfNow());
  limitPush(
    sample.events,
    {
      id: nextEventId++,
      name: 'route:/projects/:id:start',
      route: sample.route,
      projectId,
      tab: options.tab,
      atMs: options.startTimeMs === 0 ? 0 : routeOffset(sample),
      meta: sanitizeMeta({
        projectId,
        tab: options.tab,
        source: options.source,
      }),
    },
    MAX_EVENTS,
  );
}

export function setRouteTab(tab: string, projectId?: number): void {
  const sample = routeSampleFor(projectId);
  if (!sample) {
    return;
  }
  sample.tab = tab;
}

export function markRouteEvent(name: string, meta: RouteMetricMeta = {}): void {
  const sample = routeSampleFor(meta.projectId);
  if (!sample) {
    return;
  }
  const projectId = meta.projectId ?? sample.projectId;
  const tab = meta.tab ?? sample.tab;
  limitPush(
    sample.events,
    {
      id: nextEventId++,
      name,
      route: sample.route,
      projectId,
      tab,
      atMs: routeOffset(sample),
      meta: sanitizeMeta({
        ...meta,
        projectId,
        tab,
      }),
    },
    MAX_EVENTS,
  );
}

function markRouteEventOnce(key: string, name: string, meta: RouteMetricMeta = {}): void {
  const sample = routeSampleFor(meta.projectId);
  if (!sample) {
    return;
  }
  const scopedKey = `${sample.id}:${key}`;
  if (sample.onceKeys.has(scopedKey)) {
    return;
  }
  sample.onceKeys.add(scopedKey);
  markRouteEvent(name, meta);
}

export function startRouteSpan(name: string, meta: RouteMetricMeta = {}): (doneMeta?: RouteMetricMeta) => void {
  const sample = routeSampleFor(meta.projectId);
  if (!sample) {
    return () => undefined;
  }
  const startedAt = perfNow();
  const startMs = routeOffset(sample, startedAt);
  const startProjectId = meta.projectId ?? sample.projectId;
  const startTab = meta.tab ?? sample.tab;
  limitPush(
    sample.events,
    {
      id: nextEventId++,
      name: `${name}:start`,
      route: sample.route,
      projectId: startProjectId,
      tab: startTab,
      atMs: startMs,
      meta: sanitizeMeta({
        ...meta,
        projectId: startProjectId,
        tab: startTab,
        status: 'pending',
      }),
    },
    MAX_EVENTS,
  );
  let done = false;
  return (doneMeta: RouteMetricMeta = {}) => {
    if (done) {
      return;
    }
    done = true;
    const endedAt = perfNow();
    const status = doneMeta.status ?? meta.status ?? (doneMeta.error ? 'error' : 'ok');
    const projectId = doneMeta.projectId ?? startProjectId;
    const tab = doneMeta.tab ?? startTab;
    limitPush(
      sample.events,
      {
        id: nextEventId++,
        name: `${name}:end`,
        route: sample.route,
        projectId,
        tab,
        atMs: routeOffset(sample, endedAt),
        meta: sanitizeMeta({
          ...meta,
          ...doneMeta,
          projectId,
          tab,
          status,
        }),
      },
      MAX_EVENTS,
    );
    limitPush(
      sample.spans,
      {
        id: nextEventId++,
        name,
        route: sample.route,
        projectId,
        tab,
        startMs,
        endMs: routeOffset(sample, endedAt),
        durationMs: rounded(endedAt - startedAt),
        status,
        meta: sanitizeMeta({
          ...meta,
          ...doneMeta,
          projectId,
          tab,
          status,
        }),
      },
      MAX_SPANS,
    );
  };
}

function recordRouteSpan(
  name: string,
  durationMs: number,
  meta: RouteMetricMeta = {},
): void {
  const sample = routeSampleFor(meta.projectId);
  if (!sample) {
    return;
  }
  const endTime = perfNow();
  const startTime = endTime - durationMs;
  const projectId = meta.projectId ?? sample.projectId;
  const tab = meta.tab ?? sample.tab;
  limitPush(
    sample.spans,
    {
      id: nextEventId++,
      name,
      route: sample.route,
      projectId,
      tab,
      startMs: routeOffset(sample, startTime),
      endMs: routeOffset(sample, endTime),
      durationMs: rounded(durationMs),
      status: meta.status ?? (meta.error ? 'error' : 'ok'),
      meta: sanitizeMeta({
        ...meta,
        projectId,
        tab,
      }),
    },
    MAX_SPANS,
  );
}

export function startUseApiRouteSpan(url: string): (doneMeta?: RouteMetricMeta) => void {
  if (!collectionEnabled) {
    return () => undefined;
  }
  const metric = classifyUseApiUrl(url);
  if (!metric) {
    return () => undefined;
  }
  return startRouteSpan(metric.name, {
    projectId: metric.projectId,
    source: 'useApi',
    detail: metric.detail,
    url: safeUrl(url),
  });
}

export function recordUseApiCacheHit(url: string): void {
  if (!collectionEnabled) {
    return;
  }
  const metric = classifyUseApiUrl(url);
  if (!metric) {
    return;
  }
  recordRouteSpan(metric.name, 0, {
    projectId: metric.projectId,
    source: 'useApi',
    detail: metric.detail,
    url: safeUrl(url),
    cache: 'hit',
  });
}

export function startApiCallRouteSpan(path: string, input?: unknown): (doneMeta?: RouteMetricMeta) => void {
  if (!collectionEnabled) {
    return () => undefined;
  }
  const metric = classifyApiCall(path, input);
  if (!metric) {
    return () => undefined;
  }
  return startRouteSpan(metric.name, {
    projectId: metric.projectId,
    source: 'apiCall',
    detail: metric.detail,
  });
}

export function recordApiCallCacheHit(path: string, input?: unknown): void {
  if (!collectionEnabled) {
    return;
  }
  const metric = classifyApiCall(path, input);
  if (!metric) {
    return;
  }
  recordRouteSpan(metric.name, 0, {
    projectId: metric.projectId,
    source: 'apiCall',
    detail: metric.detail,
    cache: 'hit',
  });
}

export function getRouteStartupSnapshot(): RouteStartupSnapshot {
  return {
    current: current ? stripMutable(current) : undefined,
    samples: samples.map(stripMutable),
    generatedAt: Date.now(),
  };
}

export function resetRouteStartupMetrics(): void {
  samples = [];
  current = undefined;
  nextRouteId = 1;
  nextEventId = 1;
}

function classifyUseApiUrl(
  url: string,
): { name: string; projectId?: number; detail?: string } | undefined {
  try {
    const parsed = new URL(url, 'http://local');
    const path = parsed.pathname;
    const projectMatch = path.match(/^\/projects\/(\d+)$/);
    if (projectMatch) {
      return {
        name: 'projects.get',
        projectId: Number(projectMatch[1]),
      };
    }

    if (path === '/coder/sessions') {
      return {
        name: 'sessions:list',
        projectId: parseProjectId(parsed.searchParams.get('project_id')),
        detail: parsed.searchParams.get('archived') === '1' ? 'archived' : 'active',
      };
    }

    if (path === '/coder/groups') {
      return {
        name: 'groups:list',
        projectId: parseProjectId(parsed.searchParams.get('project_id')),
      };
    }

    const gitStatusMatch = path.match(/^\/projects\/(\d+)\/git\/status$/);
    if (gitStatusMatch) {
      const includeFiles = parsed.searchParams.get('includeFiles');
      return {
        name: `projectGit.status(${includeFiles === 'false' || includeFiles === '0' ? 'summary' : 'full'})`,
        projectId: Number(gitStatusMatch[1]),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function classifyApiCall(
  path: string,
  input?: unknown,
): { name: string; projectId?: number; detail?: string } | undefined {
  if (path === 'projects.get') {
    return {
      name: 'projects.get',
      projectId:
        typeof input === 'number'
          ? input
          : input && typeof input === 'object' && 'id' in input
            ? parseProjectId(String((input as { id?: unknown }).id))
            : undefined,
    };
  }

  if (path === 'projectGit.status') {
    const projectId =
      input && typeof input === 'object' && 'projectId' in input
        ? parseProjectId(String((input as { projectId?: unknown }).projectId))
        : undefined;
    const mode = includeFilesModeFromInput(input);
    return {
      name: `projectGit.status(${mode})`,
      projectId,
      detail: mode,
    };
  }

  if (
    path === 'projectGit.mergeState' ||
    path === 'projectGit.branchesDetailed' ||
    path === 'projectGit.log' ||
    path === 'projectGit.stashList' ||
    path === 'projectGit.commitDetail' ||
    path === 'projectGit.stashDetail' ||
    path === 'projectGit.baseline'
  ) {
    return { name: path, projectId: pidFromInput(input) };
  }

  // Low-frequency, useful renderer-side spans. Deliberately EXCLUDES the
  // high-cardinality / pollable channels (files.read/tree/list — many per open;
  // lsp.serverStatus — polled in a loop by the install prompt): each classified
  // call pushes a start+end event pair, and a burst of those could evict the
  // startup milestones from the bounded event ring this panel reads. Their
  // latency is already captured backend-side by the slow-ipc percentile table.
  if (path === 'lsp.codeActions') {
    return { name: path, projectId: pidFromInput(input), detail: detailPath(input) };
  }

  if (path === 'plugins.readAsset') {
    const ns = input && typeof input === 'object' && 'namespace' in input
      ? String((input as { namespace?: unknown }).namespace)
      : undefined;
    return { name: path, detail: ns };
  }

  return undefined;
}

/** Pull a `projectId` out of a typical `{ projectId, ... }` input. */
function pidFromInput(input: unknown): number | undefined {
  return input && typeof input === 'object' && 'projectId' in input
    ? parseProjectId(String((input as { projectId?: unknown }).projectId))
    : undefined;
}

/** Pull a `path`/`file`/`languageId` discriminator for span detail. */
function detailPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const raw = o.path ?? o.file ?? o.dir ?? o.languageId;
  return typeof raw === 'string' ? raw : undefined;
}

function sanitizeMeta(meta: RouteMetricMeta): RouteMetricMeta {
  const sanitized: RouteMetricMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || typeof value === 'function') {
      continue;
    }
    if (typeof value === 'string') {
      sanitized[key] = sanitizeText(value, key === 'url' ? 180 : 90);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }
    if (value === null) {
      sanitized[key] = null;
      continue;
    }
    sanitized[key] = sanitizeText(JSON.stringify(value), 140);
  }
  return sanitized;
}

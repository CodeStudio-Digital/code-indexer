/**
 * Pure parsers for `podman ... --format json` output → normalized types. Podman
 * emits a JSON array; some versions / Docker emit JSON-lines. `decodeJsonList`
 * tolerates both, and the field accessors are case-insensitive so newer
 * (lowercase `network ls`) and older (PascalCase) schemas both map cleanly.
 * No I/O — these take a raw string and return data.
 */
import type {
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  PodSummary,
  VolumeSummary,
} from './types.js';

type Row = Record<string, unknown>;

/** Parse a JSON array OR newline-delimited JSON objects into rows. */
export function decodeJsonList(raw: string): Row[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value.filter(isRow);
    if (isRow(value)) return [value];
    return [];
  } catch {
    /* fall through to JSON-lines */
  }
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (isRow(v)) rows.push(v);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

function isRow(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Case-insensitive get over a set of candidate keys. */
function get(row: Row, ...keys: string[]): unknown {
  for (const k of keys) if (k in row) return row[k];
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const hit = lower[k.toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function str(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str).filter(Boolean);
  const s = str(value);
  return s ? [s] : [];
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Flatten Podman's structured Ports array (or pass through a string). */
function formatPorts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((p) => {
      if (!isRow(p)) return str(p);
      const host = str(get(p, 'host_ip', 'hostIP'));
      const hostPort = str(get(p, 'host_port', 'hostPort'));
      const containerPort = str(get(p, 'container_port', 'containerPort'));
      const proto = str(get(p, 'protocol')) || 'tcp';
      const left = hostPort ? `${host || '0.0.0.0'}:${hostPort}->` : '';
      return `${left}${containerPort}/${proto}`;
    })
    .filter(Boolean)
    .join(', ');
}

export function parseContainers(raw: string): ContainerSummary[] {
  return decodeJsonList(raw).map((row) => ({
    id: str(get(row, 'Id', 'ID', 'ContainerID')),
    names: strArray(get(row, 'Names', 'Name')),
    image: str(get(row, 'Image')),
    state: str(get(row, 'State')),
    status: str(get(row, 'Status')),
    ports: formatPorts(get(row, 'Ports')),
    pod: str(get(row, 'Pod', 'PodName')) || undefined,
    createdAt: str(get(row, 'CreatedAt', 'Created')) || undefined,
    labels: (get(row, 'Labels') as Record<string, string>) || undefined,
  }));
}

export function parseImages(raw: string): ImageSummary[] {
  const out: ImageSummary[] = [];
  for (const row of decodeJsonList(raw)) {
    const id = str(get(row, 'Id', 'ID'));
    const size = num(get(row, 'Size', 'VirtualSize'));
    const createdAt = str(get(row, 'CreatedAt', 'Created')) || undefined;
    // Newer podman: Names/RepoTags is an array of `repo:tag`. Older: split fields.
    const refs = strArray(get(row, 'Names', 'RepoTags'));
    if (refs.length) {
      for (const reference of refs) {
        const at = reference.lastIndexOf(':');
        const repository = at > 0 ? reference.slice(0, at) : reference;
        const tag = at > 0 ? reference.slice(at + 1) : '<none>';
        out.push({ id, repository, tag, reference, size, createdAt });
      }
      continue;
    }
    const repository = str(get(row, 'Repository')) || '<none>';
    const tag = str(get(row, 'Tag')) || '<none>';
    out.push({ id, repository, tag, reference: `${repository}:${tag}`, size, createdAt });
  }
  return out;
}

export function parseVolumes(raw: string): VolumeSummary[] {
  return decodeJsonList(raw).map((row) => ({
    name: str(get(row, 'Name')),
    driver: str(get(row, 'Driver')) || 'local',
    mountpoint: str(get(row, 'Mountpoint')) || undefined,
  }));
}

export function parseNetworks(raw: string): NetworkSummary[] {
  return decodeJsonList(raw).map((row) => ({
    id: str(get(row, 'Id', 'ID', 'NetworkID')),
    name: str(get(row, 'Name')),
    driver: str(get(row, 'Driver')) || 'bridge',
  }));
}

export function parsePods(raw: string): PodSummary[] {
  return decodeJsonList(raw).map((row) => {
    const containers = get(row, 'Containers');
    const count = Array.isArray(containers)
      ? containers.length
      : num(get(row, 'NumberOfContainers')) ?? 0;
    return {
      id: str(get(row, 'Id', 'ID')),
      name: str(get(row, 'Name')),
      status: str(get(row, 'Status')),
      containers: count,
    };
  });
}

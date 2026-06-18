/** Common header names for the grid's <datalist> autocomplete + quick presets. */
import type { KvRow } from '../types.js';

export const COMMON_HEADERS: string[] = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control',
  'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'User-Agent',
  'X-Api-Key', 'X-Request-Id', 'X-Requested-With',
];

export const HEADER_PRESETS: KvRow[] = [
  { key: 'Content-Type', value: 'application/json', enabled: true },
  { key: 'Accept', value: 'application/json', enabled: true },
];

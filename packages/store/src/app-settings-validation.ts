import { getSettingDef } from './app-settings-catalog.js';
import type { SettingDef } from './app-settings/types.js';

export class InvalidAppSetting extends Error {
  constructor(readonly key: string, readonly reason: string) {
    super(`Invalid setting ${key}: ${reason}`);
  }
}

/** Validate before writing; errors contain keys and reasons, never secret values. */
export function normalizeSettingValue(def: SettingDef, value: unknown): string | null {
  if (value === null || value === '') return null;
  const invalid = (reason: string): never => { throw new InvalidAppSetting(def.key, reason); };
  if (!['string', 'number', 'boolean'].includes(typeof value)) return invalid('invalid_type');
  const text = String(value);
  if (def.type === 'bool') {
    if (text === '1' || text === 'true') return '1';
    if (text === '0' || text === 'false') return '0';
    return invalid('expected_boolean');
  }
  if (def.options && !def.options.includes(text)) return invalid('invalid_option');
  if (def.type === 'int' || def.type === 'float') {
    const number = text.trim() ? Number(text) : NaN;
    if (!Number.isFinite(number) || (def.type === 'int' && !Number.isSafeInteger(number))) {
      return invalid(def.type === 'int' ? 'expected_integer' : 'expected_number');
    }
    if (def.min !== undefined && number < def.min) return invalid('below_minimum');
    if (def.max !== undefined && number > def.max) return invalid('above_maximum');
    return String(number);
  }
  if (def.type === 'url') {
    try { if (!['http:', 'https:'].includes(new URL(text).protocol)) return invalid('expected_http_url'); }
    catch { return invalid('expected_http_url'); }
  }
  if (def.key === 'MCP_SANDBOX_CPUS' && (!Number.isFinite(Number(text)) || Number(text) <= 0)) {
    return invalid('expected_positive_cpu_limit');
  }
  if (def.key === 'MCP_SANDBOX_MEMORY' && !/^[1-9]\d*(?:[bkmg])?$/i.test(text)) {
    return invalid('expected_memory_limit');
  }
  return text;
}

export function normalizeSettingUpdates(updates: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(updates).map(([key, value]) => {
    const def = getSettingDef(key);
    if (!def) throw new InvalidAppSetting(key, 'unknown_setting');
    return [key, normalizeSettingValue(def, value)];
  }));
}

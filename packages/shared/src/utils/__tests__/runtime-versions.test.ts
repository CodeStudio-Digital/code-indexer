import { describe, expect, it } from 'vitest';
import {
  parseRuntimeVersions,
  readRuntimeVersion,
  writeRuntimeVersion,
} from '../runtime-versions.js';

describe('runtime-versions', () => {
  it('parses a well-formed JSON map', () => {
    expect(parseRuntimeVersions('{"php":"managed:8.3.7","python":"system"}')).toEqual({
      php: 'managed:8.3.7',
      python: 'system',
    });
  });

  it('is tolerant of null / corrupt / wrong-shape input', () => {
    expect(parseRuntimeVersions(null)).toEqual({});
    expect(parseRuntimeVersions(undefined)).toEqual({});
    expect(parseRuntimeVersions('')).toEqual({});
    expect(parseRuntimeVersions('not json')).toEqual({});
    expect(parseRuntimeVersions('[1,2,3]')).toEqual({});
    expect(parseRuntimeVersions('{"php":123}')).toEqual({}); // non-string dropped
  });

  it('reads a single key', () => {
    const json = '{"php":"managed:8.3.7"}';
    expect(readRuntimeVersion(json, 'php')).toBe('managed:8.3.7');
    expect(readRuntimeVersion(json, 'python')).toBeUndefined();
  });

  it('writes a key while preserving the others', () => {
    const json = writeRuntimeVersion('{"python":"pyenv:3.12.3"}', 'php', 'managed:8.3.7');
    expect(parseRuntimeVersions(json)).toEqual({
      python: 'pyenv:3.12.3',
      php: 'managed:8.3.7',
    });
  });

  it('removes a key when the id is empty / null / system (back to system default)', () => {
    const base = '{"php":"managed:8.3.7","python":"pyenv:3.12.3"}';
    expect(parseRuntimeVersions(writeRuntimeVersion(base, 'php', null))).toEqual({
      python: 'pyenv:3.12.3',
    });
    expect(parseRuntimeVersions(writeRuntimeVersion(base, 'php', ''))).toEqual({
      python: 'pyenv:3.12.3',
    });
    expect(parseRuntimeVersions(writeRuntimeVersion(base, 'php', 'system'))).toEqual({
      python: 'pyenv:3.12.3',
    });
  });

  it('round-trips through write → parse', () => {
    let json: string | null = null;
    json = writeRuntimeVersion(json, 'php', 'homebrew:8.2.1');
    json = writeRuntimeVersion(json, 'python', 'managed:3.13.0');
    expect(parseRuntimeVersions(json)).toEqual({
      php: 'homebrew:8.2.1',
      python: 'managed:3.13.0',
    });
  });
});

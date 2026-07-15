import { describe, expect, it } from 'vitest';
import { assertRuntimeVersion, managedVersionFromId } from '../runtime-version.js';

describe('runtime version validation', () => {
  it.each(['21.0.7', '11.0.100-preview.5.25277.114', '8.0.492+8'])('accepts %s', (version) => {
    expect(assertRuntimeVersion(version)).toBe(version);
    expect(managedVersionFromId(`managed:${version}`)).toBe(version);
  });

  it.each(['../escape', '21;rm -rf', '$(touch x)', '', 'a'.repeat(82)])('rejects %s', (version) => {
    expect(() => assertRuntimeVersion(version)).toThrow(/invalid runtime version/);
    expect(() => managedVersionFromId(`managed:${version}`)).toThrow(/invalid runtime version/);
  });

  it('ignores system and non-managed ids', () => {
    expect(managedVersionFromId('system')).toBeNull();
    expect(managedVersionFromId('sdkman:21')).toBeNull();
  });
});

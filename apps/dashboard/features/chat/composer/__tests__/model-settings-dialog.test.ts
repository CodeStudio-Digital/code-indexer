import { describe, expect, it } from 'vitest';
import { fixedTemperatureForModel } from '../ModelSettingsDialog.js';

describe('fixedTemperatureForModel', () => {
  it('locks exact K3 model ids to temperature 1', () => {
    expect(fixedTemperatureForModel('k3')).toBe(1);
    expect(fixedTemperatureForModel('K3')).toBe(1);
    expect(fixedTemperatureForModel('k3::coding')).toBe(1);
  });

  it('does not lock other Kimi models', () => {
    expect(fixedTemperatureForModel('kimi-for-coding')).toBeNull();
    expect(fixedTemperatureForModel('kimi-k2.6')).toBeNull();
  });
});

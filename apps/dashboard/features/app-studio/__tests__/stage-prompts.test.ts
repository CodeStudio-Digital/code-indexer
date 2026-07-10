import { describe, expect, it } from 'vitest';
import { specialistForStage } from '../stage-prompts.js';

describe('App Studio stage specialist routing', () => {
  it('routes planning stages to their constrained specialist agents', () => {
    expect(specialistForStage('discovery')).toBe('spec');
    expect(specialistForStage('architecture')).toBe('architecture');
    expect(specialistForStage('database')).toBe('db');
  });

  it('keeps execution and publishing outside planning specialist sessions', () => {
    expect(specialistForStage('design')).toBeNull();
    expect(specialistForStage('backend')).toBeNull();
    expect(specialistForStage('review')).toBeNull();
    expect(specialistForStage('launch')).toBeNull();
  });
});

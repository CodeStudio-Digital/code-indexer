import { describe, expect, it } from 'vitest';
import { specialistForStage } from '../stage-prompts.js';

describe('App Studio stage specialist routing', () => {
  it('routes planning stages to their constrained specialist agents', () => {
    expect(specialistForStage('discovery')).toBe('spec');
    expect(specialistForStage('architecture')).toBe('architecture');
    expect(specialistForStage('database')).toBe('db');
    expect(specialistForStage('ux')).toBe('ux');
    expect(specialistForStage('wireframe')).toBe('wireframe');
  });

  it('routes execution stages to dedicated conversations', () => {
    expect(specialistForStage('design')).toBe('design');
    expect(specialistForStage('backend')).toBe('backend');
    expect(specialistForStage('review')).toBe('review');
  });

  it('keeps publishing as a panel action', () => {
    expect(specialistForStage('launch')).toBeNull();
  });
});

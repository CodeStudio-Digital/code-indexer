import { describe, expect, it } from 'vitest';
import { APP_STUDIO_RAIL_TABS } from '../AppStudioRail.js';

describe('App Studio rail order', () => {
  it('follows definition, execution and delivery workflow groups', () => {
    expect(APP_STUDIO_RAIL_TABS.map((tab) => tab.id)).toEqual([
      'guide',
      'product',
      'blueprint',
      'architecture',
      'experience',
      'versions',
      'preview',
      'data',
      'publish',
    ]);
    expect(APP_STUDIO_RAIL_TABS.filter((tab) => tab.separated).map((tab) => tab.id)).toEqual([
      'preview',
      'publish',
    ]);
  });
});

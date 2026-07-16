import { describe, expect, it } from 'vitest';
import {
  validateScenarioResults,
  type ScenarioResult,
} from '../../../bench/bench-index-pipeline.js';

function result(overrides: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenario: 'cold',
    workers: 'off',
    duration_ms: 10,
    files_per_sec: 100,
    indexed: 10,
    skipped: 0,
    errors: 0,
    rss_start_mb: 100,
    rss_peak_mb: 110,
    rss_delta_mb: 10,
    ...overrides,
  };
}

describe('validateScenarioResults', () => {
  it('rejects any scenario with indexing errors', () => {
    expect(validateScenarioResults([result({ scenario: 'warm_nochange', errors: 2 })]))
      .toEqual(['warm_nochange (off): 2 indexing error(s)']);
  });

  it('rejects zero indexed files for cold and changed-content scenarios', () => {
    expect(validateScenarioResults([
      result({ scenario: 'cold', indexed: 0 }),
      result({ scenario: 'change_10pct', indexed: 0, workers: 'on' }),
    ])).toEqual([
      'cold (off): indexed zero files',
      'change_10pct (on): indexed zero files',
    ]);
  });

  it('allows zero indexed files for no-change and touch-only scenarios', () => {
    expect(validateScenarioResults([
      result({ scenario: 'warm_nochange', indexed: 0, skipped: 10 }),
      result({ scenario: 'touch_all', indexed: 0, skipped: 10 }),
    ])).toEqual([]);
  });
});

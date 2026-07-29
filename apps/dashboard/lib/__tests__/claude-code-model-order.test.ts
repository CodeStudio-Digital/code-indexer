import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_MODEL_IDS,
  sortClaudeCodeModels,
} from '../claude-code-model-order.js';

describe('Claude Code model ordering', () => {
  it('keeps current models first and legacy models in the desktop order', () => {
    const shuffled = [
      'sonnet-4-6',
      'haiku',
      'opus-4-7',
      'sonnet',
      'fable',
      'opus-4-8',
      'opus-4-6',
      'opus',
    ].map((id) => ({ id, name: id }));

    expect(sortClaudeCodeModels(shuffled, (model) => model.id, (model) => model.name)
      .map((model) => model.id)).toEqual(CLAUDE_CODE_MODEL_IDS);
  });

  it('places unknown models last without mutating the API response', () => {
    const models = [
      { id: 'custom-z', name: 'Zulu' },
      { id: 'opus', name: 'Opus 5' },
      { id: 'custom-a', name: 'Alpha' },
    ];

    expect(sortClaudeCodeModels(models, (model) => model.id, (model) => model.name)
      .map((model) => model.id)).toEqual(['opus', 'custom-a', 'custom-z']);
    expect(models.map((model) => model.id)).toEqual(['custom-z', 'opus', 'custom-a']);
  });
});

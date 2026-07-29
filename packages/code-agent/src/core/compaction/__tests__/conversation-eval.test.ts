import { describe, expect, it } from 'vitest';
import type { CompactionSummaryV3 } from '@mcp/code-agent/core/summarizer.js';
import { evaluateConversationCompaction, recallAtK } from '../conversation-eval.js';

const facts = [
  { id: 'objective', acceptedPhrases: ['ship the chaptered auto-resume'] },
  { id: 'constraint', acceptedPhrases: ['never delete the raw transcript'] },
  { id: 'decision', acceptedPhrases: ['use fts5 before embeddings'] },
  { id: 'resolved', acceptedPhrases: ['duplicate summarizer call removed'] },
  { id: 'pending', acceptedPhrases: ['run the migration smoke test'] },
] as const;

function chapterId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function plantedSummary(checkpoint: number): CompactionSummaryV3 {
  return {
    version: 3,
    chapter: {
      title: `Checkpoint ${checkpoint}`,
      summary: 'Duplicate summarizer call removed.',
      user_requests: [],
      decisions: ['Use FTS5 before embeddings.'],
      work_completed: [],
      files: [],
      open_issues: [],
      resolved_issues: ['Duplicate summarizer call removed.'],
    },
    resume: {
      objective: 'Ship the chaptered auto-resume.',
      current_focus: 'Validation',
      constraints: ['Never delete the raw transcript.'],
      pending_tasks: ['Run the migration smoke test.'],
      next_step: 'Run the migration smoke test.',
    },
  };
}

describe('conversation compaction acceptance eval', () => {
  it('gates critical retention after 1/5/10 compactions and recall@3', () => {
    const result = evaluateConversationCompaction({
      checkpoints: [1, 5, 10].map((checkpoint) => ({ checkpoint, summary: plantedSummary(checkpoint) })),
      facts,
      recallCases: Array.from({ length: 10 }, (_, index) => ({
        query: `fact ${index}`,
        expectedChapterId: chapterId(index + 1),
        rankedChapterIds: index === 9
          ? [chapterId(99), chapterId(98), chapterId(97), chapterId(index + 1)]
          : [chapterId(index + 1)],
      })),
    });
    expect(result.retentionByCheckpoint.map((item) => item.ratio)).toEqual([1, 1, 1]);
    expect(result.recallAt3).toBe(0.9);
    expect(result.passes).toBe(true);
  });

  it('fails when a critical fact is lost at any checkpoint', () => {
    const degraded = plantedSummary(10);
    degraded.resume.constraints = [];
    const result = evaluateConversationCompaction({
      checkpoints: [{ checkpoint: 10, summary: degraded }],
      facts,
      recallCases: [],
    });
    expect(result.minimumRetention).toBe(0.8);
    expect(result.passes).toBe(false);
  });

  it('compares chapter UUIDs as opaque strings without numeric coercion', () => {
    expect(recallAtK([{
      query: 'chapter identity',
      expectedChapterId: chapterId(42),
      rankedChapterIds: ['42', chapterId(42)],
    }], 1)).toBe(0);
  });
});

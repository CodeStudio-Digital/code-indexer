import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

/**
 * Migration 102 — `output_chars_shaped` column + savings aggregation in
 * getToolCallStats.
 *
 * Tests cover the contract surfaced through the `/api/coder/sessions/:id/tool-stats`
 * endpoint:
 *   1. Tools with shaped < raw show non-zero savings.
 *   2. Tools where shaped IS NULL (pre-shaping / synthetic refusals)
 *      contribute zero — COALESCE keeps the aggregation honest.
 *   3. Tools where shaped == raw show zero savings (no smart reducer
 *      fired, no truncation).
 *   4. The byTool list filters out zero-savings rows and is sorted by
 *      savings descending.
 *   5. Token estimate is chars / 4 (textbook English heuristic).
 */

describe('SessionStore.getToolCallStats — savings aggregation (migration 102)', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projectId: number;
  let sessionId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'savings-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projectId = db.createProject('savings-proj', workDir).id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sessionId = store.createSession({
      project_id: projectId,
      title: 's',
      provider: 'anthropic',
      model: 'sonnet',
    }).id;
  });

  /**
   * Helper: persists an assistant turn carrying a fixed-shape list of tool
   * calls. Each entry's `output_chars` defaults to result_text.length when
   * not explicitly provided (mirrors the store's own behavior). The
   * `output_chars_shaped` field defaults to `null` ("not recorded").
   */
  function persistToolCalls(
    calls: Array<{
      tool_name: string;
      result_text: string;
      output_chars?: number;
      output_chars_shaped?: number | null;
      is_error?: boolean;
    }>,
  ): void {
    store.persistAssistantTurn({
      session_id: sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'turn' }] },
      usage: null,
      tool_calls: calls.map((c, i) => ({
        tool_use_id: `toolu_${i}`,
        tool_name: c.tool_name,
        args: {},
        result_text: c.result_text,
        is_error: !!c.is_error,
        duration_ms: 1,
        output_chars: c.output_chars,
        output_chars_shaped: c.output_chars_shaped ?? null,
      })),
    });
  }

  it('reports totalSavedChars == 0 and empty byTool when no tool calls', () => {
    const stats = store.getToolCallStats(sessionId);
    expect(stats.totalCalls).toBe(0);
    expect(stats.savings.totalSavedChars).toBe(0);
    expect(stats.savings.totalSavedTokensEst).toBe(0);
    expect(stats.savings.byTool).toEqual([]);
  });

  it('aggregates savings when shaped < raw for a single tool', () => {
    persistToolCalls([
      // 10_000 raw chars → 2_000 shaped (8_000 saved)
      { tool_name: 'run_command', result_text: 'x'.repeat(10_000), output_chars_shaped: 2_000 },
    ]);
    const stats = store.getToolCallStats(sessionId);
    expect(stats.savings.totalRawChars).toBe(10_000);
    expect(stats.savings.totalShapedChars).toBe(2_000);
    expect(stats.savings.totalSavedChars).toBe(8_000);
    expect(stats.savings.totalSavedTokensEst).toBe(2_000); // 8000 / 4
    expect(stats.savings.byTool).toEqual([
      { name: 'run_command', rawChars: 10_000, shapedChars: 2_000, savedChars: 8_000 },
    ]);
  });

  it('treats NULL shaped as raw (no savings contributed)', () => {
    persistToolCalls([
      // Synthetic refusal / pre-shaping path — output_chars_shaped left NULL
      { tool_name: 'apply_patch', result_text: 'y'.repeat(5_000), output_chars_shaped: null },
    ]);
    const stats = store.getToolCallStats(sessionId);
    expect(stats.savings.totalSavedChars).toBe(0);
    expect(stats.savings.byTool).toEqual([]); // filtered (zero savings)
  });

  it('omits zero-savings tools from byTool but still counts raw chars', () => {
    persistToolCalls([
      // Smart reducer fired but produced same size as input (unchanged)
      { tool_name: 'read_file', result_text: 'a'.repeat(500), output_chars_shaped: 500 },
      // Real savings on a different tool
      { tool_name: 'run_command', result_text: 'b'.repeat(8_000), output_chars_shaped: 1_000 },
    ]);
    const stats = store.getToolCallStats(sessionId);
    expect(stats.savings.totalRawChars).toBe(8_500);
    expect(stats.savings.totalShapedChars).toBe(1_500);
    expect(stats.savings.totalSavedChars).toBe(7_000);
    expect(stats.savings.byTool).toHaveLength(1);
    expect(stats.savings.byTool[0].name).toBe('run_command');
  });

  it('sorts byTool by savedChars descending', () => {
    persistToolCalls([
      { tool_name: 'small_saver', result_text: 'x'.repeat(2_000), output_chars_shaped: 500 },
      { tool_name: 'big_saver',   result_text: 'y'.repeat(20_000), output_chars_shaped: 2_000 },
      { tool_name: 'mid_saver',   result_text: 'z'.repeat(10_000), output_chars_shaped: 4_000 },
    ]);
    const stats = store.getToolCallStats(sessionId);
    const names = stats.savings.byTool.map((t) => t.name);
    expect(names).toEqual(['big_saver', 'mid_saver', 'small_saver']);
  });

  it('accumulates savings across multiple calls to the same tool', () => {
    persistToolCalls([
      { tool_name: 'run_command', result_text: 'a'.repeat(5_000), output_chars_shaped: 1_000 },
      { tool_name: 'run_command', result_text: 'b'.repeat(3_000), output_chars_shaped: 500 },
    ]);
    const stats = store.getToolCallStats(sessionId);
    expect(stats.savings.byTool).toEqual([
      { name: 'run_command', rawChars: 8_000, shapedChars: 1_500, savedChars: 6_500 },
    ]);
  });

  it('clamps totalSavedChars at 0 when shaped > raw (defensive — should never happen in practice)', () => {
    persistToolCalls([
      // Pathological: someone records a shaped size LARGER than the raw size.
      // This can't happen via the runner path but the aggregation must not
      // surface negative "savings" to the dashboard.
      { tool_name: 'odd_tool', result_text: 'a'.repeat(100), output_chars_shaped: 200 },
    ]);
    const stats = store.getToolCallStats(sessionId);
    expect(stats.savings.totalSavedChars).toBe(0);
    expect(stats.savings.byTool).toEqual([]); // zero savings → filtered out
  });
});

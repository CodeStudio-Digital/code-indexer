import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readClaudeCode } from '../claude-code.js';
import { readCodex } from '../codex.js';
import { detectExternalSessionSource, previewExternalSession } from '../registry.js';

const fixture = (name: string): string => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

describe('external session adapters', () => {
  it('rebuilds only the selected Claude branch and tolerates an incomplete final line', async () => {
    const path = fixture('claude-fork.jsonl');
    const document = await readClaudeCode({
      source: 'claude-code', source_path: path, external_id: 'claude-session-1',
    });

    expect(document.messages).toHaveLength(4);
    expect(JSON.stringify(document.messages)).not.toContain('Abandoned fork');
    expect(JSON.stringify(document.messages)).not.toContain('private');
    expect(JSON.stringify(document.messages)).toContain('Build the importer');
    expect(document.source_summary).toContain('tests remain');
    expect(document.stats.tool_call_count).toBe(1);
    expect(document.stats.tool_result_count).toBe(1);
    expect(document.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed_jsonl_lines' }),
    ]));
    expect(previewExternalSession(document).reference.fingerprint).toHaveLength(64);
  });

  it('reads Codex response items without developer, reasoning, event duplicates or replacement history', async () => {
    const path = fixture('codex-rollout.jsonl');
    const document = await readCodex({ source: 'codex', source_path: path, external_id: 'codex-session-1' });
    const serialized = JSON.stringify(document.messages);

    expect(document.messages).toHaveLength(6);
    expect(serialized).toContain('Implement the API');
    expect(serialized).toContain('API implemented');
    expect(serialized).not.toContain('private instructions');
    expect(serialized).not.toContain('replacement_history');
    expect(document.stats.tool_call_count).toBe(2);
    expect(document.source_summary).toBe('The API exists; add UI next.');
    expect(document.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_response_items' }),
    ]));
  });

  it('detects a manual JSONL source', async () => {
    await expect(detectExternalSessionSource(fixture('claude-fork.jsonl'))).resolves.toBe('claude-code');
    await expect(detectExternalSessionSource(fixture('codex-rollout.jsonl'))).resolves.toBe('codex');
  });

  it('does not turn subagent JSONLs into standalone sessions', async () => {
    await expect(readClaudeCode({
      source: 'claude-code', source_path: fixture('subagents/claude-subagent.jsonl'), external_id: 'claude-subagent',
    })).rejects.toMatchObject({ code: 'unsupported_format' });
    await expect(readCodex({
      source: 'codex', source_path: fixture('codex-subagent.jsonl'), external_id: 'codex-subagent',
    })).rejects.toMatchObject({ code: 'unsupported_format' });
  });
});

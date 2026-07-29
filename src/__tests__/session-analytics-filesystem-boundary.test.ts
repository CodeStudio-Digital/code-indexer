import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('session analytics filesystem boundary', () => {
  it('does not query retired SQLite session tables', async () => {
    for (const file of [
      join('src', 'benchmarks', 'runner-baseline.ts'),
      join('scripts', 'eval-agent-engineering.ts'),
    ]) {
      const source = await readFile(join(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(
        /\b(?:coder_sessions|coder_messages|coder_tool_calls|coder_turn_telemetry|coder_session_inputs|session_file_review_comments)\b/i,
      );
      expect(source, file).not.toMatch(/\.prepare\s*\(/);
      expect(source, file).toContain('FsSessionStore');
    }
  });
});

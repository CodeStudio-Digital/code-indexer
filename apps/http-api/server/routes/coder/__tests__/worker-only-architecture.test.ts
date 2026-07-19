import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

describe('coder worker-only architecture', () => {
  it('keeps runCoder out of backend route modules', () => {
    const stream = source('../stream.ts');
    const interaction = source('../interaction.ts');
    const sessions = source('../sessions.ts');

    expect(stream).not.toMatch(/\bawait\s+runCoder\s*\(\s*\{/);
    expect(stream).not.toMatch(/import\s*\{[^}]*\brunCoder\b[^}]*\}/s);
    expect(interaction).not.toContain('.runner');
    expect(sessions).not.toContain('.runner');
  });

  it('has no environment switch that can restore in-process execution', () => {
    const singleton = source('../../../../sse/coderWorkerPoolSingleton.ts');
    const settings = source('../../../../../../packages/store/src/app-settings/mcp.ts');
    expect(singleton).not.toContain('MCP_CODER_WORKER');
    expect(settings).not.toMatch(/key:\s*'MCP_CODER_WORKER'/);
    expect(singleton).toContain('In-process coder execution is not supported.');
  });

  it('boots runCoder only inside coder-worker', () => {
    const worker = source('../../../../workers/coder-worker.ts');
    expect(worker).toMatch(/\brunCoder\s*\(\s*\{/);
  });
});

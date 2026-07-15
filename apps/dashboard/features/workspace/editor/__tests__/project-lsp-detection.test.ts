import { describe, expect, it } from 'vitest';
import type { DetectedRunners } from '@mcp/api-bus';
import { projectLspLanguages } from '../project-lsp-detection.js';

function detected(...managers: DetectedRunners['groups'][number]['manager'][]): DetectedRunners {
  return {
    groups: managers.map((manager) => ({ manager, source: String(manager), runners: [], installNeeded: false })),
  };
}

describe('projectLspLanguages', () => {
  it('detects Java once for Maven and Gradle projects', () => {
    expect(projectLspLanguages(detected('maven', 'gradle'))).toEqual(['java']);
  });

  it('detects C# from dotnet and preserves polyglot projects', () => {
    expect(projectLspLanguages(detected('gradle', 'dotnet'))).toEqual(['java', 'csharp']);
  });

  it('does not propose Java/C# support for unrelated projects', () => {
    expect(projectLspLanguages(detected('npm', 'python'))).toEqual([]);
  });
});

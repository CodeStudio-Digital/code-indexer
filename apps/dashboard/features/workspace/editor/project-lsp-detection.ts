import type { DetectedRunners } from '@mcp/api-bus';

type ProjectLspLanguage = 'java' | 'csharp';

/** Convert existing runner/project detection into languages worth probing at project open. */
export function projectLspLanguages(detected: DetectedRunners | null): ProjectLspLanguage[] {
  if (!detected) return [];
  const languages = new Set<ProjectLspLanguage>();
  for (const group of detected.groups) {
    if (group.manager === 'maven' || group.manager === 'gradle' || group.manager === 'java') {
      languages.add('java');
    }
    if (group.manager === 'dotnet') languages.add('csharp');
  }
  return [...languages];
}

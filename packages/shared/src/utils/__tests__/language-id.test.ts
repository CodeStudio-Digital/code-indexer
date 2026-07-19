import { describe, expect, it } from 'vitest';
import { languageIdForDocument, languageIdForPath } from '../language-id.js';

describe('languageIdForPath build and launcher files', () => {
  it.each([
    ['gradlew', 'shell'],
    ['tools/mvnw', 'shell'],
    ['.bashrc', 'shell'],
    ['scripts/start.zsh', 'shell'],
    ['gradlew.bat', 'bat'],
    ['tools/setup.cmd', 'bat'],
    ['build.gradle', 'groovy'],
    ['settings.gradle', 'groovy'],
    ['Jenkinsfile', 'groovy'],
    ['build.gradle.kts', 'kotlin'],
    ['src/App.csproj', 'xml'],
    ['Directory.Build.props', 'xml'],
    ['Directory.Build.targets', 'xml'],
    ['packages/example.nuspec', 'xml'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile.dev', 'dockerfile'],
    ['Containerfile', 'dockerfile'],
    ['containers/Containerfile.release', 'dockerfile'],
    ['legacy/app.containerfile', 'dockerfile'],
  ])('maps %s to %s', (path, expected) => {
    expect(languageIdForPath(path)).toBe(expected);
  });

  it.each([
    ['release', '#!/bin/bash\necho release', 'shell'],
    ['bootstrap', '#!/usr/bin/env -S sh -eu\necho bootstrap', 'shell'],
    ['tool', '#!/usr/bin/env python3\nprint("ok")', 'python'],
    ['cli', '#!/usr/bin/env node\nconsole.log("ok")', 'javascript'],
  ])('uses the shebang for extensionless %s', (path, content, expected) => {
    expect(languageIdForDocument(path, content)).toBe(expected);
  });

  it('does not override an explicit file extension from a misleading shebang', () => {
    expect(languageIdForDocument('script.rb', '#!/bin/bash\nputs "ok"')).toBe('ruby');
  });
});

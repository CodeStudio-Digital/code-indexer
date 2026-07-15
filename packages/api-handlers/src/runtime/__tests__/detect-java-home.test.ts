/**
 * javaHomeOf / javaVersionOf — pure JDK-layout resolution over temp fixtures.
 * Covers the three real archive layouts (bin at root, single nested folder,
 * macOS Contents/Home) and the `release` metadata parse that replaces spawning
 * `java -version` (which prints to stderr).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectJavaRuntimes, javaHomeOf, javaVersionOf } from '../detect-java.js';

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const JAVAC_EXE = process.platform === 'win32' ? 'javac.exe' : 'javac';
const tmps: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-jdk-'));
  tmps.push(dir);
  return dir;
}

/** Lay a fake JDK home under `home`: bin/java + optional release file. */
function layJdk(home: string, version?: string): void {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', JAVA_EXE), '');
  if (version) {
    writeFileSync(join(home, 'release'), `IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="${version}"\n`);
  }
}

afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('javaHomeOf', () => {
  it('bin/java at the install root → the root itself', () => {
    const dir = fixture();
    layJdk(dir);
    expect(javaHomeOf(dir)).toBe(dir);
  });

  it('single nested folder (Temurin archive) → the nested home', () => {
    const dir = fixture();
    const nested = join(dir, 'jdk-21.0.11+10');
    layJdk(nested);
    expect(javaHomeOf(dir)).toBe(nested);
  });

  it('macOS Contents/Home layout → that home (also under a nested folder)', () => {
    const dir = fixture();
    const home = join(dir, 'jdk-21.0.11+10', 'Contents', 'Home');
    layJdk(home);
    expect(javaHomeOf(dir)).toBe(home);
  });

  it('garbage dir (no java anywhere) → null', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    expect(javaHomeOf(dir)).toBeNull();
  });

  it('missing dir → null', () => {
    expect(javaHomeOf(join(fixture(), 'nope'))).toBeNull();
  });
});

describe('javaVersionOf', () => {
  it('parses JAVA_VERSION from the release metadata file', () => {
    const dir = fixture();
    layJdk(dir, '21.0.11');
    expect(javaVersionOf(dir)).toBe('21.0.11');
  });

  it('normalizes the "+build" suffix away', () => {
    const dir = fixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release'), 'JAVA_VERSION="17.0.9+9"\n');
    expect(javaVersionOf(dir)).toBe('17.0.9');
  });

  it('no release file → empty string (never throws)', () => {
    expect(javaVersionOf(fixture())).toBe('');
  });
});

describe('detectJavaRuntimes', () => {
  it('does not expose a managed JRE until the matching javac exists', () => {
    const dataDir = fixture();
    const home = join(dataDir, 'java', '21.0.7');
    layJdk(home, '21.0.7');
    expect(detectJavaRuntimes(dataDir).filter((runtime) => runtime.source === 'managed')).toEqual([]);

    writeFileSync(join(home, 'bin', JAVAC_EXE), '');
    expect(detectJavaRuntimes(dataDir).filter((runtime) => runtime.source === 'managed'))
      .toEqual([expect.objectContaining({ id: 'managed:21.0.7', version: '21.0.7' })]);
  });
});

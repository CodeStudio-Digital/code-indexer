/**
 * CompanyDriveStore tests for the metadata/payload split inside a root Company
 * session bundle. Reusable templates never own or share operational drive data.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { CompanyDriveStore } from '@mcp/company/services/CompanyDriveStore.js';
import {
  SessionLocator,
  asCompanySessionId,
  asSessionId,
  type CompanySessionId,
  type JsonValue,
} from '@mcp/session-storage';

let dir: string;
let projectRoot: string;
let sessionStore: FsSessionStore;
let rootAId: CompanySessionId;
let childAId: CompanySessionId;
let rootBId: CompanySessionId;

async function createCompanySession(
  name: string,
  parentSessionId: CompanySessionId | null = null,
): Promise<CompanySessionId> {
  const created = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 1 },
    owner_project_id: 1,
    linked_projects: [{ project_id: 1, root_path: projectRoot }],
    parent_session_id:
      parentSessionId == null ? null : asSessionId(parentSessionId),
    title: name,
    status: 'idle',
    metadata: {
      company: {
        name,
        template_id: 1,
        runtime_kind: 'company',
        config_json: '{}',
        master_session_id: null,
        project_labels: { 1: 'main' },
        recovered_at: null,
        recovered_reason: null,
      },
    } as unknown as Record<string, JsonValue>,
  });
  await sessionStore.refresh();
  return asCompanySessionId(created.session.id);
}

function makeDrive(sessionId: CompanySessionId): CompanyDriveStore {
  return new CompanyDriveStore({
    sessionStore,
    companySessionId: sessionId,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-drive-fs-'));
  const dataDir = join(dir, 'data');
  projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  sessionStore = new FsSessionStore({
    locator: new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 1 ? projectRoot : null,
        listProjectRoots: () => [{
          project_id: 1,
          root_path: projectRoot,
        }],
      },
    }),
  });
  rootAId = await createCompanySession('root-a');
  childAId = await createCompanySession('child-a', rootAId);
  rootBId = await createCompanySession('root-b');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanyDriveStore', () => {
  it('uses the root session UUID as its scope', () => {
    expect(makeDrive(rootAId).resolveScopeKey()).toBe(`session:${rootAId}`);
    expect(makeDrive(childAId).resolveScopeKey()).toBe(`session:${rootAId}`);
  });

  it('write/read round-trips and reports size correctly', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    const meta = drive.write(scope, 'specs/auth.md', 'hello world', {
      role: 'backend',
    });
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.path).toBe('specs/auth.md');
    expect(meta.sizeBytes).toBe(11);
    expect(meta.ownerRole).toBe('backend');

    const read = drive.read(scope, 'specs/auth.md');
    expect(read.content).toBe('hello world');
    expect(read.truncated).toBe(false);
    expect(read.meta.sizeBytes).toBe(11);
  });

  it('overwrite retains the entity UUID and updates size', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    const first = drive.write(scope, 'a.txt', 'aaaa');
    const second = drive.write(scope, 'a.txt', 'bb');
    expect(first.id).toBe(second.id);
    expect(second.sizeBytes).toBe(2);
    expect(drive.read(scope, 'a.txt').content).toBe('bb');
  });

  it('append concatenates and creates the file when missing', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    drive.append(scope, 'log.txt', 'line1\n');
    const meta = drive.append(scope, 'log.txt', 'line2\n');
    expect(meta.sizeBytes).toBe(12);
    expect(drive.read(scope, 'log.txt').content).toBe('line1\nline2\n');
  });

  it('list filters by prefix and owner role', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'specs/a.md', 'A', { role: 'backend' });
    drive.write(scope, 'specs/b.md', 'B', { role: 'frontend' });
    drive.write(scope, 'reports/c.md', 'C', { role: 'backend' });

    expect(
      drive.list(scope, { prefix: 'specs/' }).map((file) => file.path),
    ).toEqual(['specs/a.md', 'specs/b.md']);
    expect(
      drive.list(scope, { ownerRole: 'backend' }).map((file) => file.path),
    ).toEqual(['reports/c.md', 'specs/a.md']);
  });

  it('delete trashes metadata and payload inside the same bundle', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'tmp.txt', 'gone');
    const entry = sessionStore.catalog.get(asSessionId(rootAId));
    expect(entry).not.toBeNull();
    const payloadDir = join(
      entry!.location.bundle_path,
      'company',
      'drive-payloads',
    );
    expect(readdirSync(payloadDir)).toHaveLength(1);

    expect(drive.delete(scope, 'tmp.txt')).toBe(true);
    expect(drive.list(scope)).toEqual([]);
    expect(drive.delete(scope, 'tmp.txt')).toBe(false);
    expect(readdirSync(payloadDir)).toEqual([]);
    expect(
      readdirSync(
        join(entry!.location.bundle_path, 'company', 'trash', 'drive-payloads'),
      ),
    ).toHaveLength(1);
  });

  it('child sessions share the root bundle drive', () => {
    const rootDrive = makeDrive(rootAId);
    const childDrive = makeDrive(childAId);
    rootDrive.write(rootDrive.resolveScopeKey(), 'shared.md', 'hi');
    expect(
      childDrive.read(childDrive.resolveScopeKey(), 'shared.md').content,
    ).toBe('hi');
  });

  it('separate sessions remain isolated even when based on the same template', () => {
    const driveA = makeDrive(rootAId);
    const driveB = makeDrive(rootBId);
    driveA.write(driveA.resolveScopeKey(), 'a.md', 'A');
    expect(driveB.list(driveB.resolveScopeKey())).toEqual([]);
    expect(() =>
      driveB.read(driveB.resolveScopeKey(), 'a.md'),
    ).toThrow(/not found/);
  });

  it('rejects another session scope, traversal and unsafe paths', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    expect(() =>
      drive.write(`session:${rootBId}`, 'foreign.md', 'x'),
    ).toThrow(/does not belong/);
    expect(() => drive.write(scope, '../escape.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'foo/../escape.md', 'x')).toThrow();
    expect(() => drive.write(scope, '/abs/path.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'foo\\bar.md', 'x')).toThrow();
    expect(() => drive.write(scope, 'control\x01char.md', 'x')).toThrow();
  });

  it('accepts realistic paths and keeps its payload directory in the bundle', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'Meu Projeto/relatórios/v1 (final).md', 'ok');
    drive.write(scope, 'data/2024-q3.json', '{}');
    expect(drive.list(scope)).toHaveLength(2);
    const bundle = sessionStore.catalog.get(asSessionId(rootAId))!.location
      .bundle_path;
    expect(existsSync(join(bundle, 'company', 'drive-payloads'))).toBe(true);
  });

  it('read truncates at maxBytes and honors offsets', () => {
    const drive = makeDrive(rootAId);
    const scope = drive.resolveScopeKey();
    drive.write(scope, 'big.txt', 'abcdefghij');
    const first = drive.read(scope, 'big.txt', { maxBytes: 4 });
    expect(first.content).toBe('abcd');
    expect(first.truncated).toBe(true);
    const second = drive.read(scope, 'big.txt', {
      offset: 4,
      maxBytes: 4,
    });
    expect(second.content).toBe('efgh');
    expect(second.truncated).toBe(true);
    const third = drive.read(scope, 'big.txt', { offset: 6 });
    expect(third.content).toBe('ghij');
    expect(third.truncated).toBe(false);
  });
});

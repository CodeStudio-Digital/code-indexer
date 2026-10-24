/**
 * Security: path-traversal containment for OpenAPI spec discovery and file-backed
 * request bodies (binary / form-data). These close an arbitrary-file-read oracle
 * and a read-file-then-POST exfil primitive when the path is attacker/agent/import
 * supplied. Reads are bounded independently of script execution.
 */
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeOpenApiOnHost } from '../openapi-probe.js';
import { encodeBody } from '../body-encode.js';
import { readProjectFile } from '../read-project-file.js';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'apiclient-root-'));
  outside = await mkdtemp(join(tmpdir(), 'apiclient-secret-'));
  await writeFile(join(root, 'openapi.json'), '{"openapi":"3.0.0"}', 'utf8');
  await writeFile(join(root, 'inside.bin'), 'IN', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'TOPSECRET', 'utf8');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('probeOpenApiOnHost containment', () => {
  it('reads an in-root explicit spec', async () => {
    const r = await probeOpenApiOnHost(root, 'openapi.json');
    expect(r?.raw).toContain('3.0.0');
  });
  it('refuses a ../ traversal escape (returns null, no read)', async () => {
    expect(await probeOpenApiOnHost(root, '../../../etc/passwd')).toBeNull();
    expect(await probeOpenApiOnHost(root, join(outside, 'secret.txt'))).toBeNull();
  });
});

describe('encodeBody file containment', () => {
  const binReq = (path: string) => ({ body_kind: 'binary', body_binary_path: path });

  it('refuses a symlink/junction pointing outside the project', async () => {
    await expect(encodeBody(binReq('escape/secret.txt'), {}, { fileRoot: root })).rejects.toThrow('escapes the project root');
    expect(await probeOpenApiOnHost(root, 'escape/secret.txt')).toBeNull();
  });

  it('enforces a byte cap without returning a partial file and checks cancellation', async () => {
    await expect(readProjectFile('inside.bin', { fileRoot: root }, 1)).rejects.toThrow('byte limit');
    const controller = new AbortController(); controller.abort(new Error('cancelled read'));
    await expect(readProjectFile('inside.bin', { fileRoot: root, signal: controller.signal })).rejects.toThrow('cancelled read');
    await expect(readProjectFile('inside.bin', { fileRoot: root, beforeRead: () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
  });

  it('reads an in-root file when contained', async () => {
    const r = await encodeBody(binReq(join(root, 'inside.bin')), {}, { fileRoot: root });
    expect(r.body?.toString()).toBe('IN');
  });
  it('refuses an out-of-root absolute path when not allowed', async () => {
    await expect(encodeBody(binReq(join(outside, 'secret.txt')), {}, { fileRoot: root }))
      .rejects.toThrow(/escapes the project root/);
  });
  it('refuses a ../ traversal when contained', async () => {
    await expect(encodeBody(binReq('../../secret.txt'), {}, { fileRoot: root }))
      .rejects.toThrow(/escapes the project root/);
  });
  it('refuses any file body when no policy is supplied', async () => {
    await expect(encodeBody(binReq(join(outside, 'secret.txt')), {}))
      .rejects.toThrow(/not permitted/);
  });
  it('allows an out-of-root path for a trusted caller (allowAbsoluteFiles)', async () => {
    const r = await encodeBody(binReq(join(outside, 'secret.txt')), {}, { allowAbsoluteFiles: true });
    expect(r.body?.toString()).toBe('TOPSECRET');
  });
});

describe('encodeBody multipart header injection', () => {
  it('strips CR/LF and escapes quotes in a field name (no injected part headers)', async () => {
    const req = { body_kind: 'form-data', body_form_json: JSON.stringify([{ key: 'a"\r\nX-Injected: 1', value: 'v', enabled: true }]) };
    const body = (await encodeBody(req, {}, { boundary: 'B' })).body?.toString() ?? '';
    expect(body).toContain('name="a%22X-Injected: 1"'); // CRLF stripped, quote → %22, all on one line
    expect(body).not.toMatch(/name="a"\r\nX-Injected/); // the raw injection is gone
  });
});

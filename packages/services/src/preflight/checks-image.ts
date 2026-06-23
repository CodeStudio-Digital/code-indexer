/**
 * Sandbox base-image presence. Only meaningful once Podman is installed;
 * otherwise it's deferred (reported ok with a "checked later" note). Non-blocking.
 */
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { DEFAULT_NODE_IMAGE } from '../sandbox/sandbox-manager/types.js';
import type { CheckResult } from './types.js';

export async function checkSandboxImage(shell: IShellPort, podmanPresent: boolean): Promise<CheckResult> {
  if (!podmanPresent) {
    return { id: 'sandbox-image', label: 'Sandbox image', status: 'ok', blocking: false, message: 'Checked after Podman is set up.' };
  }
  try {
    const r = await shell.run('podman', ['images', '-q', DEFAULT_NODE_IMAGE], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    if ((r.stdout || '').trim().length > 0) {
      return { id: 'sandbox-image', label: 'Sandbox image', status: 'ok', blocking: false, message: `Base image ${DEFAULT_NODE_IMAGE} present.`, detail: { image: DEFAULT_NODE_IMAGE } };
    }
    return { id: 'sandbox-image', label: 'Sandbox image', status: 'warn', blocking: false, message: `Base image ${DEFAULT_NODE_IMAGE} not pulled yet — the first sandbox will build/pull it.`, remediation: 'pull-or-build-image', detail: { image: DEFAULT_NODE_IMAGE } };
  } catch {
    return { id: 'sandbox-image', label: 'Sandbox image', status: 'ok', blocking: false, message: 'Image check skipped.' };
  }
}

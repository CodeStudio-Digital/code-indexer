import { spawn as spawnChild } from 'node:child_process';
import {
  resolveRuntimeBinary,
  sessionNetworkName,
} from '../manager/util/naming.js';

/**
 * Create the per-session network if it doesn't already exist. Idempotent:
 * the `network create` exits non-zero when the network already exists; we
 * tolerate that — any other failure is logged and returns null so the
 * container falls back to the default bridge.
 */
export async function ensureSessionNetwork(sessionId: string): Promise<string | null> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  return await new Promise<string | null>((resolve) => {
    const child = spawnChild(binary, ['network', 'inspect', name], { stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      if (code === 0) {
        resolve(name);
        return;
      }
      // Network doesn't exist yet — create it.
      const create = spawnChild(binary, ['network', 'create', name], { stdio: 'ignore' });
      create.once('error', () => resolve(null));
      create.once('close', (createCode) => {
        resolve(createCode === 0 ? name : null);
      });
    });
  });
}

/**
 * Remove the per-session network. Called by destroyAllServicesForSession
 * after every attached container is gone. Best-effort.
 */
export async function destroySessionNetwork(sessionId: string): Promise<void> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  await new Promise<void>((resolve) => {
    const child = spawnChild(binary, ['network', 'rm', name], { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/**
 * Attach an already-running container to the session network. Used to
 * retro-connect the primary container (created on the default bridge) to
 * the session network when the first additional service is added.
 * Idempotent — attaching twice is a no-op error that we swallow.
 */
export async function attachContainerToSessionNetwork(
  sessionId: string,
  containerId: string,
  alias: string,
): Promise<void> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  await new Promise<void>((resolve) => {
    const child = spawnChild(
      binary,
      ['network', 'connect', '--alias', alias, name, containerId],
      { stdio: 'ignore' },
    );
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

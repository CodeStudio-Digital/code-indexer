import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';

type ChildIdentity = Pick<ControlPlaneRunContext, 'agentRunId'>;
export function nativeChildSessionRoot(root: string, context: ChildIdentity): string {
  if (!isAbsolute(root) || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(context.agentRunId)) {
    throw new Error('Invalid native child journal identity or root');
  }
  return join(root, 'children', context.agentRunId);
}

/** Validate each ancestor before creating the next directory. A junction at
 * children must not cause a directory to be written outside the session root. */
export async function resolveNativeChildSessionRoot(root: string, context: ChildIdentity, create = false): Promise<string> {
  const target = nativeChildSessionRoot(root, context);
  const inspect = async (path: string) => {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Unsafe native child journal directory');
    return realpath(path);
  };
  const canonical = await inspect(root);
  const same = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  for (const suffix of [['children'], ['children', context.agentRunId]]) {
    const path = join(root, ...suffix);
    if (create) {
      try { await mkdir(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
    }
    if (!same(await inspect(path), join(canonical, ...suffix))) throw new Error('Native child journal escaped its root');
  }
  return target;
}

export function nativeChildTranscriptRef(context: ControlPlaneRunContext, rootAttemptId: string): string {
  const reference = `native-child-journal:${context.sessionId}:${context.agentRunId}:${context.attemptId}:${rootAttemptId}`;
  parseNativeChildTranscriptRef(reference); return reference;
}

export function parseNativeChildTranscriptRef(reference: string) {
  const parts = typeof reference === 'string' ? reference.split(':') : [];
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  if (parts.length !== 5 || parts[0] !== 'native-child-journal' || parts.slice(1).some(part => !uuid.test(part))) {
    throw new Error('Invalid native child transcript reference');
  }
  return { sessionId: parts[1]!, agentRunId: parts[2]!, attemptId: parts[3]!, rootAttemptId: parts[4]! };
}

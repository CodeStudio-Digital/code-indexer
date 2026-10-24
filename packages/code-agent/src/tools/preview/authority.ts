import type { ResourceBinding } from '@mcp/agent-runtime-contracts';

export interface PreviewAuthority {
  payload: unknown;
  binding?: ResourceBinding;
  toolUseId?: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Reconstruct the physical request from the exact input sealed by admission.
 * Worker-supplied wire arguments are never a second source of authority. */
export function previewDispatchArguments(method: string, input: Record<string, unknown>, projectId?: number | null): Record<string, unknown> {
  const select = (...keys: string[]) => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const selector = () => ({ selector: String(input.selector ?? '') });
  switch (method) {
    case 'open': {
      const url = String(input.url ?? '').trim();
      if (!url && projectId == null) throw new Error('Preview has no project context');
      return { ...(url ? { url } : { projectId }), ...select('preset', 'width', 'height') };
    }
    case 'navigate': return { url: String(input.url ?? '').trim() };
    case 'viewport': return select('preset', 'width', 'height', 'deviceScaleFactor', 'mobile');
    case 'console': return select('level', 'waitMs', 'limit');
    case 'network': return select('urlFilter', 'status', 'includeBody', 'bodyMaxChars', 'bodyTotalMaxChars', 'limit', 'waitForMs');
    case 'eval': return { js: String(input.js ?? ''), ...select('timeoutMs') };
    case 'screenshot': return { fullPage: !!input.fullPage };
    case 'storage': return { kind: input.kind ?? 'local' };
    case 'snapshot': return select('interactiveOnly', 'maxDepth', 'limit');
    case 'inspect_css': case 'click': case 'hover': case 'double_click': case 'right_click': return selector();
    case 'fill': return { ...selector(), value: String(input.value ?? '') };
    case 'type': return { text: String(input.text ?? ''), ...(input.selector ? selector() : {}) };
    case 'press': return { key: String(input.key ?? ''), ...(input.selector ? selector() : {}),
      ...(Array.isArray(input.modifiers) ? { modifiers: input.modifiers } : {}) };
    case 'wait_for': return { ...selector(), ...select('timeoutMs') };
    case 'scroll': return { ...(input.selector ? selector() : {}), ...select('x', 'y') };
    case 'close': case 'performance': case 'memory': return {};
    default: throw new Error('Preview method is not an admitted tool');
  }
}

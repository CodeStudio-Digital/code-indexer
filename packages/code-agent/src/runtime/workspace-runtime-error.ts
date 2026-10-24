export function workspaceRuntimeConflict(message: string): Error & { code: 'WORKSPACE_RUNTIME_CONFLICT' } {
  return Object.assign(new Error(message), { code: 'WORKSPACE_RUNTIME_CONFLICT' as const });
}

export function isWorkspaceRuntimeConflict(error: unknown): error is Error & { code: 'WORKSPACE_RUNTIME_CONFLICT' } {
  return error instanceof Error && (error as Error & { code?: string }).code === 'WORKSPACE_RUNTIME_CONFLICT';
}

/** Fast behavioral gate. Exhaustive coverage remains in `test:workspace`. */
export const criticalPaths = [
  'packages/code-agent/src/core/runner/nodes/__tests__',
  'packages/code-agent/src/core/__tests__/permission-gate',
  'packages/code-agent/src/core/__tests__/vision-context.test.ts',
  'packages/code-agent/src/core/__tests__/tool-extra-user-messages.test.ts',
  'packages/code-agent/src/ports/__tests__/tool-snapshot-history.test.ts',
  'packages/code-agent/src/sessions/fs-store/__tests__/bundle-tool-output-store.test.ts',
  'packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-crud.test.ts',
  'packages/code-agent/src/sessions/fs-store/__tests__/fs-session-store-conversation.test.ts',
  'packages/code-agent/src/providers/__tests__',
  'src/__tests__/chatgpt-stream-handler.test.ts',
  'packages/services/src/services/docs/__tests__/attachment',
  'apps/http-api/server/routes/coder/__tests__/session-images.test.ts',
  'apps/dashboard/features/chat/__tests__',
  'apps/dashboard/features/chat/messages/__tests__',
];

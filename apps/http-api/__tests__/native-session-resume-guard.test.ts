import { expect, it } from 'vitest';
import type { FsSessionWithMessages } from '@mcp/session-storage/fs-store/index.js';
import { hasResumableNativeToolAttachments } from '../native-session-resume-guard.js';

function history() {
  return { session: { id: 'session' }, messages: [
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'image-tool', content: 'done' }] },
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', base64: 'fixture' }] },
  ], message_rows: [
    { id: 'session:native:1', session_id: 'session', role: 'tool', operation_id: 'image-tool' },
    { id: 'session:native:2', session_id: 'session', role: 'user', operation_id: 'image-tool:attachments' },
  ] } as FsSessionWithMessages;
}

it('recognizes only native projected tool attachments paired with the preceding result', () => {
  expect(hasResumableNativeToolAttachments(history())).toBe(true);
  for (const field of ['id', 'session_id', 'operation_id'] as const) {
    const data = history();
    Object.assign(data.message_rows[1]!, { [field]: 'ordinary-user-input' });
    expect(hasResumableNativeToolAttachments(data)).toBe(false);
  }
  const unpaired = history();
  unpaired.message_rows[0]!.operation_id = 'other';
  expect(hasResumableNativeToolAttachments(unpaired)).toBe(false);
  const completed = history();
  completed.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] });
  expect(hasResumableNativeToolAttachments(completed)).toBe(false);
});

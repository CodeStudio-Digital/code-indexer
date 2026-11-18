import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerActionIcons } from '../ComposerActionIcons.js';
import { QueuedMessages } from '../QueuedMessages.js';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('QueuedMessages attachments', () => {
  it('keeps queued attachments visible with their names and count', () => {
    const html = renderToStaticMarkup(createElement(QueuedMessages, {
      items: [{
        id: 'queue-1',
        text: 'review this',
        attachments: [
          { name: 'one.txt', mediaType: 'text/plain', text: 'one' },
          { name: 'two.txt', mediaType: 'text/plain', text: 'two' },
        ],
        mode: 'end-of-session',
        status: 'pending',
      }],
      onPromote: vi.fn(),
      onRemove: vi.fn(),
    }));

    expect(html).toContain('one.txt, two.txt');
    expect(html).toContain('2</span>');
  });

  it('keeps the file picker enabled during a queue-capable live run', () => {
    const html = renderToStaticMarkup(createElement(ComposerActionIcons, {
      streaming: true,
      allowAttachmentsWhileStreaming: true,
      handleFiles: vi.fn(),
      showMic: false,
    }));
    const input = html.match(/<input[^>]+type="file"[^>]*>/)?.[0];

    expect(input).toBeDefined();
    expect(input).not.toContain('disabled');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../../components/ui/tooltip.js';
import { ComposerActionIcons } from '../ComposerActionIcons.js';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('ComposerActionIcons code-comment policy', () => {
  it('renders code-comment blocking as enabled by default', () => {
    const html = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(ComposerActionIcons, {
        streaming: false,
        handleFiles: vi.fn(),
        blockCodeComments: true,
        setBlockCodeComments: vi.fn(),
        showMic: false,
      }),
    ));

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Block code comments');
  });
});

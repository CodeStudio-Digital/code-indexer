import { createElement } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useEditorSettingsStore } from '../../../../../state/editor-settings.js';
import { EditorCodeStylePane, EditorGeneralPane } from '../EditorPreferencesPane.js';

describe('EditorPreferencesPane', () => {
  beforeEach(() => {
    useEditorSettingsStore.setState({ global: {}, projects: { 7: {} }, hydrated: { 7: true }, configs: {} });
  });

  it('renders the global/project scope and inherited editor controls', () => {
    const html = renderToStaticMarkup(createElement(EditorGeneralPane, { projectId: 7 }));
    expect(html).toContain('Escopo das preferências');
    expect(html).toContain('Global');
    expect(html).toContain('Este projeto');
    expect(html).toContain('Herdado de padrão do editor');
    expect(html).toContain('Família da fonte');
  });

  it('keeps save/type formatting off and paste formatting on by default', () => {
    const html = renderToStaticMarkup(createElement(EditorCodeStylePane, { projectId: 7 }));
    expect(html).toMatch(/Formatar ao colar[\s\S]*?data-state="checked"/);
    expect(html).toMatch(/Formatar ao salvar[\s\S]*?data-state="unchecked"/);
    expect(html).toMatch(/Formatar ao digitar[\s\S]*?data-state="unchecked"/);
  });
});

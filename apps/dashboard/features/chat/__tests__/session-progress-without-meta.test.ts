import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionStateSidebar } from '../SessionStateSidebar.js';

vi.mock('react-i18next', async (importOriginal: () => Promise<typeof import('react-i18next')>) => ({
  ...await importOriginal(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('session progress without Meta', () => {
  it('keeps the agent checklist visible with completion and active task state', () => {
    const html = renderToStaticMarkup(createElement(SessionStateSidebar, {
      sessionId: 'test-session',
      embedded: true,
      todos: [
        { id: 'done', content: 'Plano aprovado', activeForm: 'Aprovando plano', status: 'completed' },
        { id: 'active', content: 'Validar tarefas', activeForm: 'Validando tarefas', status: 'in_progress' },
      ],
    }));
    expect(html).toContain('chat:todos.title');
    expect(html).toContain('Plano aprovado');
    expect(html).toContain('Validando tarefas');
    expect(html).not.toContain('state.goal');
    expect(html).not.toContain('state.goalBudget');
  });
});

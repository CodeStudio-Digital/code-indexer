import { describe, expect, it, vi } from 'vitest';
import { buildCommandActions, filterCommands, type CommandSources } from '../command-actions.js';

const Icon = () => null;

function makeSources(overrides: Partial<CommandSources> = {}): CommandSources {
  return {
    nav: [{ id: 'home', label: 'Projetos', href: '/', icon: Icon }],
    projects: [{ id: 7, name: 'whatsapp-pro-api' }],
    navigate: vi.fn(),
    toggleTheme: vi.fn(),
    toggleLanguage: vi.fn(),
    labels: { toggleTheme: 'Alternar tema', toggleLanguage: 'Alternar idioma' },
    ...overrides,
  };
}

describe('buildCommandActions', () => {
  it('emits groups in nav → projects → actions order', () => {
    const actions = buildCommandActions(makeSources());
    expect(actions.map((a) => a.group)).toEqual(['nav', 'projects', 'actions', 'actions']);
  });

  it('routes nav and project actions to the right destinations', () => {
    const navigate = vi.fn();
    const actions = buildCommandActions(makeSources({ navigate }));

    actions.find((a) => a.id === 'nav:home')!.run();
    actions.find((a) => a.id === 'project:7')!.run();

    expect(navigate).toHaveBeenNthCalledWith(1, '/');
    expect(navigate).toHaveBeenNthCalledWith(2, '/projects/7');
  });

  it('wires the theme and language toggles to their callbacks', () => {
    const toggleTheme = vi.fn();
    const toggleLanguage = vi.fn();
    const actions = buildCommandActions(makeSources({ toggleTheme, toggleLanguage }));

    actions.find((a) => a.id === 'action:theme')!.run();
    actions.find((a) => a.id === 'action:lang')!.run();

    expect(toggleTheme).toHaveBeenCalledTimes(1);
    expect(toggleLanguage).toHaveBeenCalledTimes(1);
  });
});

describe('filterCommands', () => {
  const actions = buildCommandActions(makeSources());

  it('returns everything for an empty query', () => {
    expect(filterCommands(actions, '')).toHaveLength(actions.length);
    expect(filterCommands(actions, '   ')).toHaveLength(actions.length);
  });

  it('matches on label, case-insensitively', () => {
    expect(filterCommands(actions, 'PROJETOS').map((a) => a.id)).toContain('nav:home');
    expect(filterCommands(actions, 'WHATSAPP').map((a) => a.id)).toEqual(['project:7']);
  });

  it('matches on secondary descriptions', () => {
    const withHint = [{ ...actions[0]!, hint: 'Workspace navigation' }];
    expect(filterCommands(withHint, 'WORKSPACE')).toEqual(withHint);
  });
});

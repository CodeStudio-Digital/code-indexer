import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AngularProfileControl } from '../AngularProfileControl.js';

import i18n from '../../../../../i18n/index.js';
import { bootstrapTestI18n } from '../../../../../i18n/test-bootstrap.js';

let previousLanguage: string;
beforeAll(async () => {
  await bootstrapTestI18n();
  previousLanguage = i18n.language;
  await i18n.changeLanguage('pt-BR');
});
afterAll(async () => { await i18n.changeLanguage(previousLanguage); });

describe('AngularProfileControl', () => {
  it('keeps profile management available after an override was selected', () => {
    const html = renderToStaticMarkup(createElement(AngularProfileControl, {
      projectId: 7,
      status: {
        state: 'ready',
        route: {
          routeId: 'opaque',
          familyId: 'angular-language-server',
          profileId: 'angular-12',
          workspaceId: 'facet',
          workspacePath: 'apps/legacy',
          versionSource: 'override',
        },
      },
      onApplied: () => undefined,
    }));
    expect(html).toContain('Alterar perfil do Angular');
  });

  it('does not offer an override when the detected version is authoritative', () => {
    const html = renderToStaticMarkup(createElement(AngularProfileControl, {
      projectId: 7,
      status: {
        state: 'ready',
        route: {
          routeId: 'opaque',
          familyId: 'angular-language-server',
          profileId: 'angular-21',
          workspaceId: 'facet',
          workspacePath: '.',
          versionSource: 'installed',
        },
      },
      onApplied: () => undefined,
    }));
    expect(html).toBe('');
  });
});

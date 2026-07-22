import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AngularProfileControl } from '../AngularProfileControl.js';

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
    expect(html).toContain('Alterar perfil Angular');
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

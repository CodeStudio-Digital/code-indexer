import { describe, expect, it } from 'vitest';
import { ApiError } from '@mcp/api-bus';
import { defineLspRoute, type LspRouteIdentity } from '@mcp/services/lsp/lsp-route.js';
import type { LspServerDef } from '@mcp/services/lsp/lsp-server-types.js';
import type { AngularProfileTarget } from '../angular-profile-routing.js';
import { validateRestartServerTarget } from '../restart-server-validation.js';

const identity: LspRouteIdentity = {
  familyId: 'angular-language-server',
  profileId: 'angular-12',
  workspaceFingerprint: 'workspace-a',
  workspaceRoot: 'C:\\repo\\legacy',
};

const def: LspServerDef = {
  id: 'angular-language-server-v12',
  label: 'Angular 12',
  languages: ['typescript'],
  role: 'overlay',
  install: { kind: 'npm', package: '@angular/language-server', version: '12.2.0' },
  args: [],
  sizeLabel: 'small',
  familyId: identity.familyId,
  profileId: identity.profileId,
  projectResolver: 'angular-core',
};

const routeId = defineLspRoute(identity).routeId;
const projectRoot = 'C:\\repo';
const boundRoute = {
  routeId,
  serverId: def.id,
  languageId: 'typescript',
  familyId: identity.familyId,
  profileId: identity.profileId,
  workspaceRoot: identity.workspaceRoot!,
};
const angular: AngularProfileTarget = {
  def,
  identity,
  selection: {} as AngularProfileTarget['selection'],
  target: { serverId: def.id, identity },
};

type Input = Omit<Parameters<typeof validateRestartServerTarget>[0], 'projectRoot'>;

function validate(input: Input) {
  return validateRestartServerTarget({ projectRoot, ...input });
}

function capture(input: Input): ApiError {
  try {
    validate(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected restart validation to fail');
}

describe('validateRestartServerTarget', () => {
  it('accepts a route that still matches its server and Angular profile', () => {
    expect(validate({
      serverId: def.id, routeId, file: 'legacy/src/app.ts', languageId: 'typescript',
      def, boundRoute, angular,
    })).toEqual({ kind: 'route', routeId });
  });

  it('accepts an Admin route restart without guessing an Angular file', () => {
    expect(validate({ serverId: def.id, routeId, def, boundRoute }))
      .toEqual({ kind: 'route', routeId });
  });

  it.each([
    ['unknown server', { serverId: 'missing', routeId, boundRoute, angular }, 404],
    ['invalid route id', { serverId: def.id, routeId: 42, def }, 400],
    ['stale route', { serverId: def.id, routeId, def, boundRoute: null }, 404],
    ['cross-server route', {
      serverId: def.id, routeId, def, boundRoute: { ...boundRoute, serverId: 'other' }, angular,
    }, 409],
    ['stale profile', {
      serverId: def.id, routeId, def, boundRoute: { ...boundRoute, profileId: 'angular-11' }, angular,
    }, 409],
    ['changed Angular workspace', {
      serverId: def.id, routeId, file: 'legacy/src/app.ts', languageId: 'typescript', def, boundRoute,
      angular: { ...angular, identity: { ...identity, workspaceFingerprint: 'workspace-b' } },
    }, 409],
  ] as const)('rejects %s before restart', (_label, input, status) => {
    expect(capture(input).status).toBe(status);
  });

  it('rejects a file whose current Angular profile belongs to another server', () => {
    const current = {
      ...angular,
      def: { ...def, id: 'angular-language-server-v13', profileId: 'angular-13' },
    };
    expect(capture({
      serverId: def.id, file: 'legacy/src/app.ts', languageId: 'typescript', def, angular: current,
    }).status).toBe(409);
  });

  it.each([
    '../outside/app.ts',
    'C:\\other\\app.ts',
  ])('rejects a file outside the project: %s', (file) => {
    expect(capture({ serverId: def.id, file, def }).status).toBe(400);
  });

  it('rejects a file outside the workspace bound to a route', () => {
    expect(capture({
      serverId: def.id,
      routeId,
      file: 'modern/src/app.ts',
      languageId: 'typescript',
      def,
      boundRoute,
      angular,
    }).status).toBe(409);
  });

  it('requires route or file context for an Angular-profile restart', () => {
    expect(capture({ serverId: def.id, def }).status).toBe(400);
  });
});

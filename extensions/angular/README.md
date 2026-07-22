# Angular language support

The bundled Angular plugin uses the official `@angular/language-server` and
lets the host select an exact server profile for each Angular workspace. No
WebStorm/IntelliJ implementation is copied into the product.

## Compatibility

| Project | Server | Tier |
| --- | --- | --- |
| Angular 9 | 0.901.11 | Best effort |
| Angular 10 | 0.1001.1 | Best effort |
| Angular 11 | 11.2.14 | Best effort |
| Angular 12 | 12.2.3 | Best effort |
| Angular 13 | 13.3.4 | Best effort |
| Angular 14 | 14.2.0 | Best effort |
| Angular 15 | 15.2.1 | Full |
| Angular 16 | 16.2.0 | Full |
| Angular 17 | 17.3.2 | Full |
| Angular 18 | 18.2.0 | Best effort |
| Angular 19 | 19.2.4 | Full |
| Angular 20 | 20.3.0 | Full |
| Angular 21 | 21.2.18 | Full |
| Angular 22 | 22.0.7 | Full |

Angular 2–8 have no official `@angular/language-server` profile. They remain an
explicit unsupported/fallback state instead of being opened with an
incompatible modern server. AngularJS 1.x is outside this plugin.

Angular 18 is marked best effort because the final 18.x server package carries
an `18.2.0-rc.0` language-service dependency. Legacy tiers can be disabled
without affecting modern profiles.

## Resolution and isolation

The host discovers Angular CLI workspaces, nested packages, and Nx project
facets. For each file it resolves `@angular/core` in this order:

1. installed package;
2. package lock (`package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`);
3. an unambiguous `package.json` major;
4. a project-scoped manual profile override;
5. `needs-profile` when guessing would be unsafe.

Each selected `(project, workspace, profile)` has its own opaque route and
diagnostic source. Server versions install side by side, and the launcher probes
the workspace's dependencies before its own installation. Completion resolve,
code actions, navigation, refactoring, diagnostics, and restarts keep the route
that originated the request.

Manual choices are stored in the project database, never in repository files.
Changing a choice invalidates discovery and retires the project's old Angular
routes. Installation remains consent-gated in the editor/admin UI.

## Operational controls

- `MCP_ANGULAR_LSP_ENABLED=0` disables Angular language servers.
- `MCP_ANGULAR_LSP_LEGACY=0` disables best-effort profiles.
- `MCP_ANGULAR_LSP_DISABLED_MAJORS=12,18` quarantines selected majors.

Every profile declares its own Node and TypeScript range. The manager first
uses a compatible project-managed Node runtime, then the app runtime when it is
compatible; it never silently runs a profile on an incompatible Node version.

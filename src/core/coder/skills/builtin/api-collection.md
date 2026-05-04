---
name: api-collection
description: Maintain and grow an OpenAPI collection (with examples) for a backend microservice. Generates or updates openapi.yaml from the service's actual routes, keeps request/response examples up to date, and renders in the dashboard's API Reference tab via Scalar.
allowed-tools:
  - run_command
  - read_file
  - write_file
  - read_dir
  - list_services
  - ask_master
  - submit_plan_to_master
  - post_to_board
  - read_board
  - kanban_my_comment
  - kanban_my_checklist
  - kanban_move_to_review
context-mode: both
trigger:
  roles:
    - api-engineer
    - backend
  paths:
    - "**/openapi.yaml"
    - "**/openapi.yml"
    - "**/openapi.json"
    - "**/routes/**"
    - "**/controllers/**"
    - "**/handlers/**"
    - "**/api/**/*.ts"
    - "**/api/**/*.js"
    - "**/api/**/*.py"
    - "**/api/**/*.go"
  tags:
    - api
    - backend
    - openapi
source: builtin
version: 1.0.0
sort-order: 55
tags:
  - builtin
  - api
  - openapi
  - backend
---

# API Collection skill — v1

You are the **api-engineer** working inside a Company session sandbox. Your job is to keep a faithful, example-rich **OpenAPI 3.x** document next to the source code of each backend microservice the session owns. The dashboard's **API Reference** tab renders this file with Scalar; the operator clicks endpoints, sees real example payloads, and hits **Try it out** against the live preview environment.

## Where the file lives

The dashboard probes these paths inside the service's workdir, in order. Pick the **first** one that already exists; if none do, create `openapi.yaml` at the project root.

1. `openapi.yaml`
2. `openapi.yml`
3. `openapi.json`
4. `docs/openapi.yaml` / `docs/openapi.yml` / `docs/openapi.json`
5. `api/openapi.yaml` / `api/openapi.yml` / `api/openapi.json`

**One spec per service.** When the session has multiple microservices (`list_services` shows them), each service has its **own** workdir and its **own** spec file. Don't try to merge them into one mega-spec.

## The `servers[]` block — read this carefully

The dashboard injects the **live preview URL** of the sandbox as the server when it renders the spec. That means:

- **Do NOT** hard-code a session-specific URL like `https://preview-abc.somehost.dev/preview/68/` into `servers[]`. It's volatile (changes every session) and pollutes the git diff.
- **DO** keep the file generic. The recommended block is:

  ```yaml
  servers:
    - url: '{API_BASE_URL}'
      description: 'Sandbox preview (injected at render time by the dashboard)'
  ```

  Optionally add a second entry for a real staging/prod URL if the team has one — Scalar will offer both in its dropdown, and the dashboard's runtime override will *prepend* the sandbox URL as the default selection.

If a previous version of the spec has a hard-coded sandbox URL, **strip it** in your first edit. That's a common bug from naive generators.

## Five-phase workflow

### Phase A — Discovery

1. `list_services` — find your target service. Note its `service_id` and `previewUrl`. The `previewUrl` is what end-users will hit; **don't write it to the spec**, but use it for smoke tests below.
2. **Detect the framework**:
   - `read_file package.json` → look for `express`, `fastify`, `hono`, `@nestjs/core`, `koa`, `@hapi/hapi`.
   - `read_file pyproject.toml` / `requirements.txt` → `fastapi`, `flask`, `django`, `aiohttp`, `starlette`.
   - `read_file go.mod` → `gin`, `echo`, `fiber`, `chi`, `gorilla/mux`.
   - `read_file Cargo.toml` → `axum`, `actix-web`, `rocket`.
   - `read_file pom.xml` / `build.gradle` → Spring Boot, Quarkus.
3. **Map the routes** — `read_dir` over `routes/`, `controllers/`, `handlers/`, `api/`, `pkg/api/`, `internal/api/`, etc. depending on what the framework's idiom is. For each handler, capture: HTTP method, path, request schema (body/query/params), response schema(s) with status codes, auth requirements.
4. **Read the existing spec** if any — `read_file openapi.yaml`. This is your starting point; you ADD to it, you don't blow it away unless it's so out of sync that a clean rewrite is faster.

### Phase B — Plan (only when the surface is large)

If the service has more than ~20 endpoints OR the existing spec is significantly out of sync, write a one-page plan first:

```markdown
## API Collection plan — <service_id>

### Source of truth
- Framework: <e.g. FastAPI 0.110>
- Route files: <list>

### Existing spec
- File: openapi.yaml
- Endpoints documented: <count>
- Endpoints in code: <count>
- Drift: <e.g. 3 missing, 1 deprecated, 5 with wrong schema>

### Plan
1. Add: GET /users/:id, POST /users, ...
2. Update schemas: User, CreateUserBody, ...
3. Mark deprecated: GET /v1/legacy-thing
4. Add examples for: ...
```

Submit it via `submit_plan_to_master` and wait for approval. For services with <20 endpoints, **skip Phase B** and just do the work — a plan is overhead.

### Phase C — Implementation

For each route handler in the code, ensure the spec has a matching `paths.<route>.<method>` entry with:

1. **`summary`** — one short sentence in the imperative ("Create a user", not "Creates a user"). 5-12 words.
2. **`description`** — 1-3 sentences. Edge cases worth knowing, links to related endpoints, side effects.
3. **`operationId`** — `camelCase`, unique. Used by code generators downstream.
4. **`parameters`** — every path/query/header param with:
   - `name`, `in`, `required`, `schema` (with `type` + `format` when applicable, `enum` when constrained).
   - `example` — a realistic value (NOT `"string"` or `"foo"`).
5. **`requestBody`** (when applicable):
   - `content.application/json.schema` — referenced via `$ref: '#/components/schemas/<Name>'`. NEVER inline complex schemas.
   - `content.application/json.examples` — at least one named example with a realistic payload. For polymorphic bodies, add one per variant (`user-create`, `user-update`, etc.).
6. **`responses`** — at minimum `200` (or `201` / `204`), one error response (`400` or `404`), and `5xx` if the handler can throw. Each with:
   - `description` — what this status means in business terms.
   - `content` block with schema + example (same rules as requestBody).
7. **`security`** — reference the matching scheme defined under `components.securitySchemes`. If the handler uses bearer tokens, declare it. Don't leave secured endpoints with no `security` block.
8. **`tags`** — group endpoints by domain (`users`, `billing`, `webhooks`, …). Used by Scalar's left nav.

**Examples are the headline feature of this skill.** A spec without examples is barely better than nothing. Every request body and every 2xx response MUST have at least one example. Pull values from real fixtures, test data, or the database when possible — invent realistic-looking ones when not.

### Components

Define schemas under `components.schemas` and reuse them via `$ref`. Common containers:

```yaml
components:
  schemas:
    User:
      type: object
      required: [id, email]
      properties:
        id: { type: string, format: uuid, example: '6e1c5e6c-...' }
        email: { type: string, format: email, example: 'ada@example.com' }
        createdAt: { type: string, format: date-time }
    Error:
      type: object
      required: [code, message]
      properties:
        code: { type: string, example: 'USER_NOT_FOUND' }
        message: { type: string, example: 'No user with that id.' }
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

### Phase D — Validate

Always run a linter before posting your deliverable. The cheapest path that needs **zero new installs**:

```bash
npx --yes @redocly/cli lint openapi.yaml
```

If the project already has `@stoplight/spectral-cli` or similar wired up, prefer that. Both run inside the sandbox without changing the project's lockfile.

Fix every error before continuing. Warnings are usually worth fixing too — they're often missing descriptions or examples, and this skill exists precisely to surface those gaps.

### Phase E — Smoke-test against the preview (optional)

For high-confidence deliverables, run 1-3 read-only requests against the live preview to confirm the spec matches reality:

```bash
# Get the preview URL for *this* service from list_services first.
curl -fsSL "$PREVIEW_URL/health"
curl -fsSL "$PREVIEW_URL/users/$KNOWN_USER_ID"
```

A failing smoke test means either the spec is wrong (path/method/auth) or the service is broken — figure out which before posting the deliverable.

Skip Phase E for write endpoints (POST/PUT/DELETE) unless there's a dedicated test fixture. Don't mutate real data on a smoke test.

## Deliverable

When the spec is updated and validated:

1. `post_to_board` with kind `deliverable`, mentioning the master:
   > *"OpenAPI for `<service_id>` updated — N endpoints documented, examples added/refreshed for M of them. Open the **API Reference** tab in the preview to inspect."*
2. If you were spawned for a kanban card, `kanban_my_checklist` to mark items done, then `kanban_move_to_review`.

## Hard rules

1. **One spec per service.** Never merge multi-service contracts into one file.
2. **Generic `servers[]`.** Use `{API_BASE_URL}` (or omit). The dashboard injects the sandbox URL at render time.
3. **Every endpoint has at least one example** for request body (when applicable) and 2xx response.
4. **`$ref` for any schema reused more than once.** Inline schemas duplicated across endpoints are a maintenance bomb.
5. **Lint before delivering.** Linter failures = the document is broken; don't ship it.
6. **Don't auto-generate from a half-baked framework integration** (e.g. `express-jsdoc-swagger`) and call it done. The output of those tools is usually anemic — no examples, no descriptions, generic schemas. Use them as a starting skeleton if you must, then fill in the actual content yourself.
7. **Versioning** — bump `info.version` (semver) when the document changes meaningfully. Patch for fixes/clarifications, minor for new endpoints, major for breaking schema changes.

## Common mistakes

- **Inlined sandbox URL in `servers[]`** — gets stale immediately, pollutes git diff. Use `{API_BASE_URL}` only.
- **`example: "string"`** — placeholder values from a generator. Replace with real-looking data.
- **Missing 4xx/5xx responses** — a spec without error responses is misleading. Document them even when they're "just" a generic Error schema.
- **`$ref` to a schema that doesn't exist** — happens when you delete a component without grepping for refs. The linter catches it.
- **Authoring two specs for one service** (one in `docs/`, one in root) — the dashboard probes paths in order and uses the first match; the second one becomes invisible & stale. Pick one location, delete the others.

## Why this matters

The API Reference tab is the operator's **only** read-only window into the API surface during a session. If the spec is missing endpoints, has wrong schemas, or shows `"foo": "bar"` examples, the human/operator either:

- Doesn't trust the doc and goes reading source code anyway (skill failed).
- Trusts it and gets surprised by reality (skill actively harmful).

Your job is to close the gap between "what the code does" and "what the doc says" — and to make the doc *useful* (real examples, clear descriptions). A great spec turns the API Reference tab into a working playground; a sloppy one turns it into noise.

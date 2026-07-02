# UI, Electron e API Surfaces

## Visão geral

As superfícies de produto do projeto combinam dashboard React, shell Electron, API local transport-agnostic, fallback HTTP/Hono, streaming SSE/IPC, terminal integrado, company workspace, design-system studio, docs, telemetry, admin e settings.

Os principais pontos de entrada são:

- `apps/dashboard`: SPA React.
- `apps/electron`: desktop shell e backend in-process.
- `apps/http-api`: Hono HTTP/SSE/WebSocket adapter.
- `packages/api-bus`: contrato typed RPC.
- `packages/api-handlers`: handlers puros reutilizáveis.
- `apps/dashboard/lib/api-client.ts`: cliente transport-agnostic do renderer/browser.

## App shell e navegação

`AppShell` é o chrome de navegação para rotas não-workspace. A rota `/projects/:id` opta por full-bleed e não usa header global (`apps/dashboard/AppShell.tsx:1-10`). O parsing de rotas distingue `home`, `project`, `agents`, `global`, `admin`, `design-systems`, `telemetry`, `docs` e `other` (`apps/dashboard/AppShell.tsx:59-87`).

O command palette global abre com `Cmd/Ctrl+K` (`apps/dashboard/AppShell.tsx:167-177`). A navegação primária lista Projects, Agents, Global, Design Systems, Telemetry, Docs e Admin; `design-systems` é feature-gated (`apps/dashboard/AppShell.tsx:199-213`). O cluster do header agrega app menu, project breadcrumb/switcher, running tasks, recent sessions, language switcher, cloud status, theme toggle e window controls (`apps/dashboard/AppShell.tsx:236-314`). O shell ajusta padding por rota: algumas surfaces são full-bleed, outras usam container margins (`apps/dashboard/AppShell.tsx:321-326`).

## Project settings

`ProjectSettingsModal` é o hub único de configuração project-scoped. Ele cobre General, Search/Indexing, runtimes, Terminal, Memory, Appearance, Editor Theme e Danger zone (`apps/dashboard/features/project/settings/ProjectSettingsModal.tsx:1-12`). As seções são enumeradas como `general`, `search`, `node`, `php`, `python`, `terminal`, `memory`, `appearance`, `editorTheme`, `danger` (`apps/dashboard/features/project/settings/ProjectSettingsModal.tsx:33-43`).

Ao reabrir, o modal re-hidrata projeto e contexto shell/runtime mais recentes (`apps/dashboard/features/project/settings/ProjectSettingsModal.tsx:75-97`). A navegação esquerda espelha as seções (`apps/dashboard/features/project/settings/ProjectSettingsModal.tsx:117-128`). O layout é nav lateral + painel direito, com runtime environment selector nas seções runtime (`apps/dashboard/features/project/settings/ProjectSettingsModal.tsx:130-203`).

## Agents e Company Session UI

`AgentsTab` é session-driven: URL `:rootId` seleciona company session e o estado da sidebar é local à view (`apps/dashboard/features/agents/AgentsTab.tsx:47-66`). A sidebar contém session/template switching, CTA de nova company e rows de sessões com open/duplicate/delete (`apps/dashboard/features/agents/AgentsTab.tsx:83-157`). A main pane alterna session view e empty-state onboarding (`apps/dashboard/features/agents/AgentsTab.tsx:160-225`). Cada row suporta context-menu actions, affordances inline e metadata de status/data (`apps/dashboard/features/agents/AgentsTab.tsx:258-380`).

`CompanySessionView` roteia por session/front/zone/tab e streama live company state (`apps/dashboard/features/agents/CompanySessionView.tsx:87-141`). A root session é parent da árvore de tabs, e a tab ativa pode ser parent ou child sub-session (`apps/dashboard/features/agents/CompanySessionView.tsx:97-105`). Notification routes usam o contexto ativo para deep-link correto em board/pipeline notifications (`apps/dashboard/features/agents/CompanySessionView.tsx:117-136`).

A rail/painel direito hospeda company-config, inbox, env, databases, supervisor e plugin drawers; o terminal bottom panel é persistido e separado (`apps/dashboard/features/agents/CompanySessionView.tsx:160-183`). `Ctrl/Cmd+J` alterna o terminal globalmente na session view (`apps/dashboard/features/agents/CompanySessionView.tsx:214-226`). O envio de mensagens decide entre resume/start/sendMessage conforme stream/session state (`apps/dashboard/features/agents/CompanySessionView.tsx:264-317`). Runs de agentes abrem a partir do estado live/persistido mergeado (`apps/dashboard/features/agents/CompanySessionView.tsx:320-322`). Metadata da sessão alimenta sidebar/modals de projetos e skills (`apps/dashboard/features/agents/CompanySessionView.tsx:203-206`). Prompts do master são hidratados no fetch inicial para que estados bloqueados renderizem imediatamente (`apps/dashboard/features/agents/CompanySessionView.tsx:228-242`).

## Terminal de company session

`CompanyTerminalPanel` suporta targets Host, Sandbox e por projeto (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:1-18`). O spawn menu expõe Host, Sandbox opcional e project roots (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:86-105`). O fluxo de spawn carrega target + shell, controla busy/error e lembra o último target bem-sucedido (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:122-149`). Restart reutiliza target e shell da tab morta (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:195-210`). O painel inclui tab bar, error strip inline, empty-state CTA e active terminal surface (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:221-272`).

## Right rail e drawers

`SidebarRail` é a rail de ícones do lado direito para drawers de “peek while working”; ela é distinta de rails focadas em edição (`apps/dashboard/features/agents/preview-sidebar/SidebarRail.tsx:1-15`). Painéis base: Company Config, Inbox, Env, Supervisor e Databases (`apps/dashboard/features/agents/preview-sidebar/SidebarRail.tsx:45-55`). Itens avançados são persistidos atrás de toggle “More”, e deep-links ativos mantêm o grupo avançado visível (`apps/dashboard/features/agents/preview-sidebar/SidebarRail.tsx:67-95`). A renderização usa ícones core, separator, advanced toggle e ícones avançados (`apps/dashboard/features/agents/preview-sidebar/SidebarRail.tsx:109-123`).

## Design-system studio

`DsStudioView` é uma superfície tripartida: chat + content panel + right rail (`apps/dashboard/features/design-systems/studio/DsStudioView.tsx:1-7`). A tab ativa é persistida em `localStorage`, incluindo estado colapsado `none` (`apps/dashboard/features/design-systems/studio/DsStudioView.tsx:26-49`). O header tem back navigation, metadata da sessão, erro e CTA publish (`apps/dashboard/features/design-systems/studio/DsStudioView.tsx:113-131`). O layout mantém chat estável enquanto alterna preview/versions/components/docs no painel de conteúdo (`apps/dashboard/features/design-systems/studio/DsStudioView.tsx:138-178`). A rail direita alterna tabs do studio (`apps/dashboard/features/design-systems/studio/DsStudioView.tsx:179-182`).

## Componentes UI e design system

Os componentes base ficam em `apps/dashboard/components/ui`. Tabs usam lista `h-10`, estado ativo com background/shadow e focus-visible ring (`apps/dashboard/components/ui/tabs.tsx:5-50`). Dialog, dropdown-menu e tooltip existem como primitives shadcn e são usados por project settings, agents modals, toolbar/menu e affordances compactas (`apps/dashboard/components/ui/dialog.tsx`, `apps/dashboard/components/ui/dropdown-menu.tsx`, `apps/dashboard/components/ui/tooltip.tsx`).

## API client do dashboard

`apps/dashboard/lib/api-client.ts` é transport-agnostic: Electron usa IPC, browser dev cai para HTTP/SSE (`apps/dashboard/lib/api-client.ts:1-15`). O cliente mantém caches/dedup para reads idempotentes como projects, git, snapshots e LSP metadata (`apps/dashboard/lib/api-client.ts:34-54`) e uma categoria “in-flight-only” para reads live de files/tree/list e LSP status (`apps/dashboard/lib/api-client.ts:68-73`).

A base URL resolve para `mcp://app` dentro do Electron e relativa no browser dev (`apps/dashboard/lib/api-client.ts:143-149`). Detecção de renderer Electron usa user agent e `window.electronAPI.invoke` (`apps/dashboard/lib/api-client.ts:167-172`). O transporte IPC chama `electronAPI.invoke` e `electronAPI.openStream` (`apps/dashboard/lib/api-client.ts:185-195`). O fallback `dottedToHttp()` mapeia methods dotted para rotas HTTP de browser, cobrindo files, snapshots, projectGit, LSP e outros namespaces (`apps/dashboard/lib/api-client.ts:203-333`). LSP methods como completion, hover, definition, references, implementation e diagnostics mapeiam para `/api/lsp/:projectId/:op` (`apps/dashboard/lib/api-client.ts:321-331`).

## Electron main e backend in-process

Electron main process possui o backend in-process e carrega o React dashboard sem loopback HTTP (`apps/electron/main.ts:1-18`). O protocolo custom `mcp://` é registrado como secure, fetch-capable, stream-capable e CSP-bypassing (`apps/electron/main.ts:127-159`). Bootstrap inicia backend in-process, HTTP dev opcional, hardening e IPC handlers, terminal/secrets/window registry routes (`apps/electron/main.ts:219-255`). Preview/devtools bridge é wireado para janelas de preview de agentes (`apps/electron/main.ts:272-275`).

## Hono dispatch dentro do Electron

O dispatcher Hono in-process converte chamadas IPC em `Request`s sintéticas e chama `app.fetch()` sem listener TCP (`apps/electron/src/hono-dispatch.ts:1-25`). Streaming é detectado por `accept: text/event-stream`, com SSE parseado em frames IPC tipados (`apps/electron/src/hono-dispatch.ts:22-25`). Paths streaming incluem `coder.stream.*`, `docs.sources.*Stream`, `docs.research.stream`, `company.stream` e `projects.*Stream` (`apps/electron/src/hono-dispatch.ts:56-69`).

`DISPATCH_TABLE` mapeia methods IPC dotted para rotas Hono concretas, incluindo `coder.stream.sendMessage`, `coder.interaction.answer`, `admin.*`, `docs.*`, `designSystem.*`, `company.*`, `workspace.*` e streams de projects/docs/company (`apps/electron/src/hono-dispatch.ts:80-156`). `dispatchHono()` faz lookup, `app.fetch(req)`, erro estruturado em non-2xx e retorno JSON/texto (`apps/electron/src/hono-dispatch.ts:201-230`). `dispatchStreaming()` consome SSE e rende frames por async generator (`apps/electron/src/hono-dispatch.ts:232-298`). O parser preserva `event:` como `.type` quando data é objeto (`apps/electron/src/hono-dispatch.ts:317-350`).

## HTTP API surfaces

O HTTP API monta os grandes domínios: projects, files, search, snapshots, memory, runs, diff, costs, telemetry, coder, LSP, editor, git, workspace, company stream e terminal websocket (`apps/http-api/server.ts:1-41`). Design-system, config, docs e docs-agent são montados no server layer (`apps/http-api/server.ts:112-118`). Company stream upgrade e terminal websocket são surfaces distintas (`apps/http-api/server.ts:39-40`).

O in-app API client/routes em Hono inclui collection CRUD, environments CRUD, send proxy, regression runner, code generation, import/export, script assist e docs routes (`apps/http-api/server/routes/api-client/index.ts:12-25`).

## Cloud transport no Electron

O cloud transport do Electron é HTTPS low-level para o Worker remoto: anexa access token, aplica timeout e faz single retry em 401 após invalidar cache (`apps/electron/src/cloud/cloud-transport.ts:1-8`). Request construction injeta headers desktop/version/OS/device, Bearer auth opcional e JSON para non-GET (`apps/electron/src/cloud/cloud-transport.ts:36-53`). Auth failure retorna resultado 401 estruturado; erros de rede viram `{ ok:false, status:0, body:{ code:'offline' } }` (`apps/electron/src/cloud/cloud-transport.ts:55-72`). Esse transporte usa contrato cloud separado, não o API bus local (`packages/api-bus/src/cloud/contract.ts:1-8`).

## Design choices observados

- Desktop evita loopback HTTP em produção e usa backend in-process.
- `mcp://app` permite que renderer use `fetch()` sem TCP.
- API client do dashboard abstrai IPC/HTTP/SSE.
- Hono continua relevante como adapter para browser dev, Electron dispatch interno e servidor standalone.
- Company session é uma workspace UI rica com terminal, right rail e streaming de estado.
- Superfícies de produto são route-aware e full-bleed quando necessário.

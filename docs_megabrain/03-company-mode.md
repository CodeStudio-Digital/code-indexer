# Company Mode e Orquestração Multi-agent

## Visão geral

Company Mode é o runtime multi-agent do projeto. Ele modela uma sessão como uma “empresa” com master, subordinates, board, kanban, inbox, sandbox, serviços, drive, envs/databases e UI própria. O usuário ainda não pediu comparativo externo; este documento descreve apenas o nosso projeto.

A documentação funcional define o master como orquestrador, subordinates como executores e company sessions como o container para um ou mais projetos com sandbox opcional (`docs/COMPANY_MODE.md:36-45`). Templates, sessões, roles e tiers são explicitados: master é full-tier; subordinate roles podem ser bootstrap/navigate/full (`docs/COMPANY_MODE.md:55-75`). Builder mode de sessão foi aposentado e movido para workflows de builder em nível de projeto, mas serviços/container continuam disponíveis em company sessions (`docs/COMPANY_MODE.md:77-83`).

## Orchestrator como composition root

`CompanyOrchestrator` é o composition root por sessão. Ele concentra master/subordinate lifecycle, inbox, board, kanban, sandbox, drive, idle/watchdog, service supervisor, pipeline executor, reconciler e event bus compartilhado (`packages/company/src/orchestrator.ts:82-154`). O constructor passa tudo por `wireServices(...)`, indicando arquitetura baseada em serviços internos plugados ao orchestrator.

Sub-sessions/front tabs compartilham recursos do parent para sandbox, projetos, kanban, pipelines, services, env, databases, drive e docs; porém board, agent_runs, master_prompts e inbox permanecem isolados por sessão (`packages/company/src/orchestrator.ts:85-89`). O effective shared-resource session id é parent-aware; `getMasterStatus()` existe porque worker-backed orchestrators não conseguem expor getters síncronos pela fronteira de worker proxy (`packages/company/src/orchestrator.ts:156-180`).

Startup do master é assíncrono e retorna rápido enquanto sandbox provisioning e boot do run continuam em background (`packages/company/src/orchestrator.ts:183-205`). A primeira mensagem para um master dormente dispara startup preguiçoso usando config persistida de provider, model, role assignments e reasoning settings (`packages/company/src/orchestrator.ts:255-279`).

## Lifecycle de master

`MasterLifecycle` persiste role configs, allowed model pool, attachment state, timestamps de fim, resurrection timing e carrega config de `CompanySession.config_json` (`packages/company/src/services/MasterLifecycle.ts:169-333`). Notificações de subordinates são enriquecidas com contexto de board; se o master está vivo, são empurradas imediatamente; caso contrário, disparam resurrection (`packages/company/src/services/MasterLifecycle.ts:336-384`).

Eventos de idle/user-message entram pelo event bus quando disponível, formando a superfície de coordenação com `IdleController` e watchdogs (`packages/company/src/services/MasterLifecycle.ts:387-401`). Fresh start e resume seguem helper compartilhado e iniciam o service supervisor depois (`packages/company/src/services/MasterLifecycle.ts:409-462`). Resurrection é coordenada separadamente e marca o timestamp antes de chamar o helper de resurrect (`packages/company/src/services/MasterLifecycle.ts:466-482`).

## Subordinates

O orchestrator expõe métodos de lifecycle para spawn, resume, reactivate, abort, reestablish, pause, status lookup e listing (`packages/company/src/orchestrator.ts:294-343`). `reestablishSubordinate` é importante: derruba zombies, marca status DB como `error` e retoma de estado persistido, evitando runs fantasmas.

Eventos que exigem atenção do master cobrem subordinate questions, plans, tasks e terminal interactions. Pending user messages são rastreadas para que `wait_for_subordinates` possa re-disparar corretamente (`packages/company/src/orchestrator.ts:344-355`).

A implementação de subagentes reutiliza infraestrutura de `packages/code-agent`. `runSubagent` é o runner isolado usado por flows read-only e execute-task (`packages/code-agent/src/tools/implement-subagent.ts:1-19`). Specs de subagente suportam prompt, allowlist, mensagens iniciais, turn limits, abort signal, path scope e enforcement mode (`packages/code-agent/src/tools/implement-subagent.ts:44-59`). Subagentes não têm back-reference direto de usuário; comunicam via resultado final e não por `submit_plan`/`ask_user`/`submit_tasks` (`packages/code-agent/src/tools/implement-subagent.ts:190-199`).

`execute_tasks` é o orquestrador determinístico em ondas: grupos respeitam dependências e `parallel_group` (`packages/code-agent/src/tools/execute-tasks.ts:84-125`). O `kind` da task determina perfil de subagente: investigate, implement ou verify (`packages/code-agent/src/tools/execute-tasks.ts:136-156`).

## Inbox e comunicação

`MasterInboxRouter` usa roteador por sessão e sentinel `__master__`; mensagens são persistidas, `inbox_message_sent` é publicado e delivery é iniciado imediatamente (`packages/company/src/services/MasterInboxRouter.ts:72-110`). Mensagens pendentes para o master são drenadas atomicamente, `inbox_message_delivered` é publicado, o master recebe prompt combinado e um mutex evita drains concorrentes (`packages/company/src/services/MasterInboxRouter.ts:118-183`). No boot/re-hydration, pending master inbox items são retomados (`packages/company/src/services/MasterInboxRouter.ts:190-199`).

A `InboxQueue` geral suporta mensagens dirigidas a roles ou agent runs, detecção de ciclo, dead-letter escalation ao master, health checks, backpressure caps e delivery imediato para targets idle (`packages/company/src/services/InboxQueue.ts:178-418`). Mensagens com `wait=true` usam wait tokens e timeout resolution; answered/expired são resolvidas de linhas persistidas (`packages/company/src/services/InboxQueue.ts:420-474`). Observers assíncronos existem para estados answered/expired, sugerindo caminho futuro longe de senders bloqueantes (`packages/company/src/services/InboxQueue.ts:476-517`).

A documentação do produto descreve estados de inbox como pending, delivered, answered, cancelled e expired, e permite respostas humanas no lugar do recipient (`docs/COMPANY_MODE.md:217-219`).

## Board, kanban e event bus

`BoardBridge` persiste posts em `company_board` e emite no meta bus; mentions podem ser extraídas automaticamente do conteúdo (`packages/company/src/services/BoardBridge.ts:26-80`). Posts de master/system avançam watermark para evitar replay para o próprio master (`packages/company/src/services/BoardBridge.ts:68-70`). Deliverables de subordinates podem auto-avançar cards kanban de `in_progress` para `review`, adicionando comentário explicativo (`packages/company/src/services/BoardBridge.ts:82-107`).

`KanbanService` centraliza gates de movimentação. Dependency blockers são checados primeiro; quality gates podem redirecionar `done` para `review`. Ambos anotam o card via comentários e SSE events (`packages/company/src/services/KanbanService.ts:175-310`). Operações de dependency e agent assignment são persistidas e broadcastadas (`packages/company/src/services/KanbanService.ts:364-379`).

`CompanyEventBus` é síncrono, best-effort e ordenado; falhas de handler são logadas, mas não propagadas (`packages/company/src/services/CompanyEventBus.ts:61-99`).

## Drive compartilhado

`CompanyDriveStore` existe para artefatos grandes trocados entre agentes, evitando inflar inbox/board (`packages/company/src/services/CompanyDriveStore.ts:1-19`). O escopo do drive é compartilhado entre sessões de um template quando `template_id` existe; caso contrário, é compartilhado entre root session e sub-sessions via `parent_session_id` (`packages/company/src/services/CompanyDriveStore.ts:171-189`).

## Sandbox, serviços e terminais

`SandboxService` faz provisioning idempotente e deduplicado por promise em voo, prevenindo races entre resumes duplicados e sub-sessions com parent compartilhado (`packages/company/src/services/SandboxService.ts:214-334`). Config de builder vem de `CompanySession.config_json`; o service resolve primary project mounts, runtime stack, limits e sandboxes externos apoiados em projeto antes de provisionar (`packages/company/src/services/SandboxService.ts:336-467`).

Quando há QA skill, o sandbox conecta a sessão ao Chrome service compartilhado e valida config Playwright, postando warnings no board se inválida (`packages/company/src/services/SandboxService.ts:469-509`). Bindings de microservices são re-hidratados para que subordinates atinjam o container correto em vez de cair no primary sandbox (`packages/company/src/services/SandboxService.ts:540-561`).

Migrations registram multi-service sandboxes: uma sessão pode ter N containers em uma rede Docker compartilhada (`packages/store/src/migrations/035_company_sandbox_services.ts:2-20`). `company_sandbox_services` é autoritativo para persistência de service; `company_sandboxes` permanece mirror do primary service, com unicidade de host ports, containers e primary por sessão (`packages/store/src/migrations/035_company_sandbox_services.ts:30-77`). Service IDs também servem como hostnames in-network (`packages/store/src/company-sandbox-services-store.ts:1-18`). Rows persistem runtime, stack, workdir, host mount, port, mount kind, image source, primary flag, attachment status, hostname, health e restart count (`packages/store/src/company-sandbox-services-store.ts:117-185`).

A UI de terminal de company session suporta targets Host, Sandbox e per-project (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:1-17`). O menu de spawn deriva targets de projetos e sandbox availability; spawn usa Terminal API e persiste sessão em scoped state (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:86-150`). Tabs são reconciliadas no mount e podem ser reiniciadas preservando target/shell (`apps/dashboard/features/agents/terminal/CompanyTerminalPanel.tsx:155-210`).

## Env e databases

A migration `036_company_session_envs` define env vars session-scoped, compartilhadas entre microservices e injetadas em containers no provision/resume; `/app/.env` é materializado no workdir (`packages/store/src/migrations/036_company_session_envs.ts:2-16`). Linhas guardam key, value, secret flag e timestamps; secrets são mascarados na UI/list responses, mas disponíveis para agent tools (`packages/store/src/migrations/036_company_session_envs.ts:27-45`).

Databases de sessão são ponteiros rotulados para env keys e metadata; envs continuam fonte da verdade para secrets (`packages/store/src/migrations/040_company_session_databases.ts:2-20`). Rows são session-scoped, label único e primary único por provider para mapear uma URL sem prefixo deterministicamente (`packages/store/src/migrations/040_company_session_databases.ts:34-60`).

## Persistência de company state

A base company schema cria `company_templates`, `company_sessions`, `company_session_projects`, `company_agent_runs` e `company_board` (`packages/store/src/migrations/018_company_agents.ts:1-77`). Sessions guardam template, status, master session id e `config_json` (`packages/store/src/migrations/018_company_agents.ts:26-36`). Agent runs guardam company session, role, coder session id, project bindings, provider/model e lifecycle status (`packages/store/src/migrations/018_company_agents.ts:45-57`). Board entries têm author role, agent run opcional, kind, mentions e timestamp (`packages/store/src/migrations/018_company_agents.ts:62-77`).

Multi-front foi refatorado em sub-sessions: parent session é a aba principal; children reutilizam isolamento já existente de board, agent_runs, master_prompts e inbox (`packages/store/src/migrations/067_company_subsessions.ts:1-35`). `parent_session_id` foi adicionado em `company_sessions` para modelar árvores de tabs (`packages/store/src/migrations/067_company_subsessions.ts:69-78`); children são criados clonando config do parent (`packages/store/src/migrations/067_company_subsessions.ts:93-108`).

## Worker-backed API layer

No HTTP/API, company orchestrators são sempre worker-thread-backed; não há fallback in-process (`apps/http-api/sse/companyOrchestrator.ts:1-12`). A API expõe get/has/delete/spawn que proxyam para pool de worker orchestrators por `companySessionId` (`apps/http-api/sse/companyOrchestrator.ts:19-55`).

## UI de Company Mode

A tela de agents é session-driven: URL `:rootId` seleciona company session e sidebar state fica local (`apps/dashboard/features/agents/AgentsTab.tsx:47-66`). A sidebar traz switching de sessões/templates, CTA nova company e rows com open/duplicate/delete (`apps/dashboard/features/agents/AgentsTab.tsx:83-157`). A main pane alterna session view e empty-state onboarding (`apps/dashboard/features/agents/AgentsTab.tsx:160-225`).

`CompanySessionView` roteia por session/front/zone/tab e consome live company state (`apps/dashboard/features/agents/CompanySessionView.tsx:87-141`). Root session é tratada como parent da árvore de tabs; active tab pode ser parent ou child sub-session (`apps/dashboard/features/agents/CompanySessionView.tsx:97-105`). Notification routes são construídas do contexto ativo para deep-link correto (`apps/dashboard/features/agents/CompanySessionView.tsx:117-136`).

A rail/drawer direita hospeda company-config, inbox, env, databases, supervisor e plugins; terminal bottom panel é separado, resizable e persistido (`apps/dashboard/features/agents/CompanySessionView.tsx:160-183`). `Ctrl/Cmd+J` alterna terminal globalmente dentro da view (`apps/dashboard/features/agents/CompanySessionView.tsx:214-226`). Mensagens para o master escolhem entre resume/start/sendMessage conforme stream/session state (`apps/dashboard/features/agents/CompanySessionView.tsx:264-317`).

A documentação de UI define work/build/data zones e side drawers para preview, inbox, env, databases e supervisor (`docs/COMPANY_MODE.md:179-220`). Board, kanban, pipelines, docs, tests, files, git, API, terminal, drive, snapshots, archives e vectors são capabilities de sessão (`docs/COMPANY_MODE.md:188-210`).

## Design choices observados

- Company mode é runtime próprio, não só UI em cima do coder agent.
- Sub-sessions compartilham recursos caros, mas isolam conversas/board/inbox.
- Master pode ressuscitar ao receber notificações, evitando perda de contexto operacional.
- Inbox e board são persistidos e event-driven, com backpressure e dead-letter.
- Sandbox provisioning é idempotente, parent-aware e multi-service.
- Terminais são target-scoped e têm UX semelhante a workspace/IDE.
- Orchestrator no server é worker-backed, reduzindo risco de bloquear o processo HTTP.

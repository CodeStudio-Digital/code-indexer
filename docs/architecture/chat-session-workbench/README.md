# Chat Session Workbench — especificação normativa

> **Status:** implementação em andamento; S2 ativa
> **Versão:** 1.0.0
> **Data-base:** 2026-08-01
> **Autoridade:** este diretório governa a refatoração completa dos rails de sessão Coder
> **Controle executivo:** [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md)

## 1. Objetivo

Substituir a arquitetura atual dos rails de sessão por um **Session Workbench**
único, modular, tipado, responsivo e orientado a projeções de sessão. O trabalho
abrange frontend e backend e termina somente depois da retirada do caminho
legado.

Esta iniciativa NÃO é um programa de remendos no `ChatRightRail`, no
`RightPanelHost` ou no `AgentChat`. O legado pode permanecer intacto durante a
construção paralela, mas não é a arquitetura-alvo e DEVE ser removido após o
cutover.

## 2. Invariantes vinculantes

- A sessão Coder e seu bundle filesystem continuam sendo a fonte autoritativa.
- Estado operacional dos rails NÃO DEVE ganhar novas tabelas SQLite.
- Projeto, sessão global, editor e mounts compactos DEVEM usar o mesmo
  `SessionWorkbenchController` e a mesma store por `sessionId`.
- Histórico persistido e eventos vivos DEVEM compartilhar tipos, cursores e
  regras de reconciliação.
- Eventos de domínio NÃO DEVEM circular por `window.CustomEvent`.
- Alternar um painel NÃO DEVE disparar novamente o bootstrap da sessão.
- O renderer NÃO DEVE manter uma segunda política de captura do Worker Log.
- Plugins DEVEM entrar pelo registry do workbench e preservar o sandbox atual.
- Desktop estreito e mobile DEVEM oferecer acesso funcional a todos os
  destinos do rail.
- O programa só termina quando host, switch, estados, fetches e adapters
  exclusivos do rail legado forem removidos.

## 3. Escopo de produto

### Incluído

- Chat de projeto (`AgentChat`).
- Sessões globais (`GlobalSessionWorkbench`).
- Sessão Coder compacta no editor (`EditorChatRail`).
- Wrapper de sessão Coder reutilizado no App Studio.
- Navegador esquerdo de sessões.
- Activity rail e dock direito.
- Painéis, badges, preferências, histórico diagnóstico e ações em lote.
- Contratos compartilhados, query layer, command layer e projeção de eventos.

### Fora do escopo

- Rail de orquestração Company do App Studio, exceto reutilização de chrome.
- Reescrita do runtime do agente.
- Mudança da autoridade física dos bundles de sessão.
- Redesign do composer ou transcript que não seja necessário para integrar o
  novo workbench.

## 4. Mapa dos documentos

| Documento | Autoridade |
|---|---|
| [DECISIONS.md](./DECISIONS.md) | Decisões vinculantes e política de alteração |
| [00-scope-and-baseline.md](./specs/00-scope-and-baseline.md) | Escopo, baseline, não objetivos e layout-alvo |
| [01-domain-and-information-architecture.md](./specs/01-domain-and-information-architecture.md) | Modelo de domínio e organização dos destinos |
| [02-frontend-architecture.md](./specs/02-frontend-architecture.md) | Store, controller, shell, registry e adapters |
| [03-backend-contracts-and-read-model.md](./specs/03-backend-contracts-and-read-model.md) | API, serviços, paginação, comandos e ownership de dados |
| [04-events-reconciliation-and-observability.md](./specs/04-events-reconciliation-and-observability.md) | SSE, replay, revisions, logs e notificações |
| [05-ux-responsive-and-accessibility.md](./specs/05-ux-responsive-and-accessibility.md) | UX, layout responsivo, teclado, i18n e a11y |
| [06-migration-cutover-and-retirement.md](./specs/06-migration-cutover-and-retirement.md) | Migração, rollback, cutover e remoção do legado |
| [07-verification-and-performance-gates.md](./specs/07-verification-and-performance-gates.md) | Testes, budgets, gates e evidências |
| [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md) | Fonte de verdade do progresso global |
| [stages/](./stages/) | Controle detalhado e resumo de cada etapa |

## 5. Etapas executivas

| Etapa | Controle | Estado atual |
|---|---|---|
| S0 — Governança, contrato e baseline | [00-governance-contract-baseline.md](./stages/00-governance-contract-baseline.md) | Concluída |
| S1 — Backend read model | [01-backend-read-model.md](./stages/01-backend-read-model.md) | Concluída |
| S2 — Eventos e comandos | [02-events-and-commands.md](./stages/02-events-and-commands.md) | Em andamento |
| S3 — Store e controller frontend | [03-frontend-store-controller.md](./stages/03-frontend-store-controller.md) | Não iniciada |
| S4 — Shell, rails e responsividade | [04-shell-rails-responsive.md](./stages/04-shell-rails-responsive.md) | Não iniciada |
| S5 — Reconstrução dos painéis | [05-panel-rebuild.md](./stages/05-panel-rebuild.md) | Não iniciada |
| S6 — Cutover e retirada do legado | [06-cutover-legacy-retirement.md](./stages/06-cutover-legacy-retirement.md) | Não iniciada |
| S7 — Validação, performance e release | [07-validation-performance-release.md](./stages/07-validation-performance-release.md) | Não iniciada |

## 6. Regra obrigatória de atualização

Toda alteração de implementação desta iniciativa DEVE atualizar documentação no
mesmo PR/commit:

1. marcar itens executados no arquivo da etapa ativa;
2. registrar evidências imutáveis, com comando e resultado;
3. atualizar o `Resumo do realizado` da etapa;
4. registrar desvios, riscos ou decisões novas;
5. atualizar o snapshot no `IMPLEMENTATION-CHECKLIST.md`;
6. alterar este `README` quando status global, escopo ou mapa documental mudar.

Um checkbox só pode ser concluído com evidência. Prosa de implementação, relato
de agente ou intenção não substituem teste, build, benchmark, trace ou inspeção
de grafo.

Estados permitidos para etapas:

- `Não iniciada`
- `Em andamento`
- `Bloqueada`
- `Em validação`
- `Concluída`

## 7. Ordem de precedência

Em caso de conflito:

1. requisitos MUST/DEVE deste corpus;
2. contratos versionados em `@mcp/api-bus` e seus testes;
3. invariantes de sessão, SSE e filesystem já comprovados;
4. decisões em `DECISIONS.md`;
5. comportamento do rail legado;
6. documentação histórica.

## 8. Definição global de conclusão

O programa só pode ser marcado como concluído quando:

- todos os requisitos normativos estiverem rastreados;
- todas as etapas S0–S7 estiverem concluídas com evidência;
- todas as superfícies Coder usarem o mesmo Session Workbench;
- não houver fetch duplicado por painel nem eventos de domínio globais;
- navegação, dock e painéis funcionarem em desktop, layout estreito e mobile;
- replay, troca de sessão e reconciliação persistido/live estiverem provados;
- performance e acessibilidade cumprirem os budgets definidos;
- o grafo de imports do rail legado estiver zerado;
- os arquivos e contratos exclusivos do legado tiverem sido removidos;
- não existir feature flag permanente, dual-write ou adapter sem prazo.

## 9. Snapshot de execução

Em 2026-08-01, S0 e S1 foram concluídas e G0/G1 aprovados. A baseline
estrutural, visual, de rede e reattach foi capturada; a fixture determinística
de 1.000/10.000 sessões e o contrato público v1 foram adicionados. Lista,
bootstrap e quatro resources lazy usam revisions, cursors, capabilities,
disponibilidade honesta, ETag/304, coalescência e validação runtime. Cinquenta
testes, benchmark 1k/10k, typecheck, build e smoke TCP efêmero passaram. S2 está
ativa: identidade do journal, event projection, filtros e rota histórica já
foram materializados. Timeline e restart persistido estão provados; comandos
core, revisions, receipts e batch também existem. Attach/replay gap, export e
notificações duráveis seguem no próximo corte.

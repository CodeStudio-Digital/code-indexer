# 00 — Escopo, baseline e fronteiras

## 1. Objetivo

Fixar o que será substituído, o que será preservado e quais invariantes devem
ser medidos antes de qualquer cutover.

## 2. Requisitos de escopo

- **CSW-SCOPE-001** — A implementação DEVE cobrir chat de projeto, sessão
  global, editor rail e wrapper Coder do App Studio.
- **CSW-SCOPE-002** — Navegador esquerdo, activity rail, dock, painéis, badges,
  layout e contratos backend fazem parte do mesmo programa.
- **CSW-SCOPE-003** — O runtime Company não será migrado, salvo primitives de
  chrome comprovadamente genéricas.
- **CSW-SCOPE-004** — Composer e transcript só podem mudar quando a integração
  do workbench exigir uma fronteira clara; regressões de conversa são
  proibidas.
- **CSW-SCOPE-005** — O programa NÃO DEVE alterar a autoridade física dos
  bundles de sessão.
- **CSW-SCOPE-006** — Preferências pequenas de UI NÃO DEVEM ser adicionadas ao
  SQLite de sessão.
- **CSW-SCOPE-007** — Mudanças concorrentes do worktree devem ser inventariadas
  antes de cada etapa; nenhum arquivo fora do escopo pode ser normalizado ou
  revertido por conveniência.

## 3. Baseline estrutural observado

| Área | Estado inicial | Risco |
|---|---|---|
| `AgentChat.tsx` | 2.061 linhas; concentra CRUD, streams, layout, panels e composer | Alto acoplamento e renderizações amplas |
| `SessionSidebar.tsx` | Lista completa, agrupamento client-side, sem paginação/virtualização | Custo cresce com número de sessões |
| `ChatRightRail.tsx` | 11 destinos internos, plugins e modal em 40 px | Descoberta ruim e excesso de ícones |
| `RightPanelHost.tsx` | Switch central e prop drilling de todas as dependências | Toda extensão amplia o host |
| Dados do painel | `useApi`, `fetch`, stores e `window.CustomEvent` | Freshness e erros inconsistentes |
| Worker Log | Projeção efêmera no renderer e projeção persistida no servidor | Drift de política e histórico incompleto |
| Global workbench | Portais para sidebar, dock e rail | Histórico de loop React 19 |
| Responsividade | Rail direito oculto abaixo de `lg` | Funções inacessíveis em mounts estreitos |

Os números devem ser recalculados em S0, porque o worktree está ativo e pode
ter evoluído entre especificação e implementação.

## 4. Invariantes preservadas

- **CSW-INV-001** — Estado vivo continua isolado por `sessionId`.
- **CSW-INV-002** — Trocar de sessão não aborta uma execução ativa sem ação
  explícita do usuário.
- **CSW-INV-003** — Reattach respeita `Last-Event-ID` e não perde contexto
  anterior ao cursor.
- **CSW-INV-004** — Transcript persistido e turno vivo mantêm ordem de texto,
  tools e referências.
- **CSW-INV-005** — Plugins permanecem sandboxed.
- **CSW-INV-006** — Sessões globais mantêm projeto primário, linked projects e
  foco de contexto.
- **CSW-INV-007** — Snapshot continua sendo experiência ampla e não é reduzido
  a uma coluna estreita.
- **CSW-INV-008** — Runs ativos e dados históricos sobrevivem ao cutover.

## 5. Layout-alvo de código

```text
apps/dashboard/features/chat/session-workbench/
  controller/
  store/
  registry/
  shell/
  navigator/
  dock/
  panels/
  adapters/
  __tests__/

apps/http-api/server/routes/coder/session-workbench/
  routes.ts
  query-service.ts
  command-service.ts
  event-projection.ts
  schemas.ts
  __tests__/

packages/api-bus/src/
  coder-session-workbench.ts

packages/code-agent/src/sessions/fs-store/
  session-workbench-projection.ts
```

O layout pode mudar por ADR, mas as responsabilidades não podem voltar ao
`AgentChat` ou a um novo host monolítico.

## 6. Não objetivos

- Criar um design system novo para todo o dashboard.
- Mudar providers, modelos, composer ou execução do agente.
- Migrar Company Session para os contratos Coder.
- Persistir toda interação visual por sessão no backend.
- Manter compatibilidade eterna com IDs antigos de painel.

## 7. Evidência de baseline obrigatória

S0 deve registrar:

- contagem de linhas, hooks e imports dos componentes centrais;
- número de requests ao abrir sessão e ao alternar cada painel;
- React Profiler durante burst de eventos;
- comportamento em 1920×1080, 1440×900, 1280×720 e mobile;
- reattach após troca de sessão global;
- custo de listar pelo menos 1.000 sessões sintéticas;
- build e testes focados atuais.


# 02 — Arquitetura frontend

## 1. Objetivo

Separar ownership de sessão, cache/reconciliação, layout e apresentação. O
resultado não pode ser outro componente monolítico com nomes novos.

## 2. Camadas

### `SessionWorkbenchController`

Responsável por:

- sessão selecionada e projeto em foco;
- destino ativo e modo do dock;
- lifecycle de bootstrap e attach;
- adapters de projeto/global/editor;
- comandos de navegação e ações em lote;
- integração entre capabilities e registry.

Não renderiza conteúdo de painel e não contém regras de domínio específicas de
Worker Log, capítulos ou telemetry.

### `SessionWorkbenchStore`

Store externa normalizada:

```text
sessions: Map<sessionId, {
  snapshot,
  resources,
  live,
  cursors,
  revisions,
  panelViewState,
  requestState
}>
```

- **CSW-FE-001** — Selectors devem observar somente o slice necessário.
- **CSW-FE-002** — Evento diagnóstico não pode renderizar `ConversationSurface`.
- **CSW-FE-003** — Resposta atrasada de outra sessão deve ser rejeitada por
  `sessionId`, request token e revision.
- **CSW-FE-004** — Snapshot mais antigo não pode sobrescrever evento vivo.
- **CSW-FE-005** — Store deve possuir eviction LRU e limites por recurso.
- **CSW-FE-006** — Estado visual e dados de domínio devem ser armazenados em
  slices diferentes.

### Query client

- Deduplica requests concorrentes por resource/revision.
- Usa `AbortController` quando não há consumidores restantes.
- Suporta ETag/`If-None-Match`.
- Mantém estado anterior durante refresh e distingue `initialLoading`,
  `refreshing`, `stale` e `error`.
- Invalida somente resources afetados pelo comando/evento.

### Shell

`SessionWorkbenchLayout` recebe slots declarativos:

- navigator;
- conversation;
- dock;
- activity rail;
- mobile sheet.

- **CSW-FE-007** — Projeto e global não podem duplicar árvores completas de
  `SessionNavigator`, `SessionDock` ou `SessionActivityRail`.
- **CSW-FE-008** — Hosts de portal, quando inevitáveis, usam refs inertes e
  publicação idempotente fora do commit.
- **CSW-FE-009** — O shell deve manter ownership estável durante resize e troca
  de destino.

## 3. Registry de painéis

Exemplo conceitual:

```ts
interface SessionPanelDefinition {
  id: SessionRailDestination;
  group: 'primary' | 'dynamic' | 'plugin' | 'settings';
  capability: keyof SessionWorkbenchCapabilities | ((caps) => boolean);
  badgeSelector?: SessionBadgeSelector;
  preferredWidth: 'standard' | 'wide';
  load: () => Promise<SessionPanelModule>;
}
```

- **CSW-FE-010** — Host não pode usar switch por id.
- **CSW-FE-011** — Um painel recebe `sessionId`, resource selectors e commands,
  não o estado inteiro de `AgentChat`.
- **CSW-FE-012** — Painéis internos e plugins compartilham chrome, erro, loading
  e ações de fechar.
- **CSW-FE-013** — Lazy chunks só carregam quando o destino for aberto ou
  explicitamente preloaded em idle.

## 4. Preservação de estado

Componentes pesados podem desmontar. Antes disso, publicam no
`SessionPanelViewState` apenas estado serializável pequeno. Scroll usa âncora
semântica (`eventId`, `chapterId`, item index), não pixel absoluto quando a lista
é virtualizada.

- **CSW-FE-014** — Busca, filtros, aba e expansão sobrevivem à troca de painel.
- **CSW-FE-015** — Estado visual é isolado por sessão quando seu significado é
  session-scoped.
- **CSW-FE-016** — Preferência global nunca restaura destino sem capability.

## 5. Adapters de superfície

- `ProjectSessionWorkbenchAdapter`: projeto fixo, preview opcional.
- `GlobalSessionWorkbenchAdapter`: linked projects e foco de contexto.
- `EditorSessionWorkbenchAdapter`: navigator compacto e dock overlay.
- `AppStudioCoderSessionAdapter`: configura seleção e contexto sem duplicar
  lifecycle.

Adapters só traduzem contexto de host. Eles não podem implementar fetch,
replay, CRUD ou painéis próprios.

## 6. Tratamento de erro

- Bootstrap 404 remove seleção obsoleta e volta ao empty state.
- 409 de revision refaz somente o resource afetado.
- Falha de painel mantém rail e dock utilizáveis.
- Falha do SSE mostra estado stale e tenta reattach com cursor.
- Falha de chunk oferece retry sem recarregar a sessão.
- Comando otimista possui rollback local e erro visível.

## 7. Remoções frontend obrigatórias

Após S6, devem desaparecer:

- estado `activeRightPanelId` dentro de `AgentChat`;
- renderização duplicada inline/portal dos rails;
- switch de `RightPanelHost`;
- `window.CustomEvent` para Drive, chapter, diagram e similares;
- política frontend de captura do Worker Log;
- fetch de badge acionado por troca de painel;
- wrappers modais mantidos exclusivamente para compatibilidade do rail antigo.


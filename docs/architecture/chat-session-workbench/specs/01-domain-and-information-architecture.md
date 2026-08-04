# 01 — Domínio e arquitetura da informação

## 1. Objetivo

Definir entidades, estados e destinos de navegação antes de definir componentes
ou endpoints.

## 2. Modelo de domínio

### `SessionWorkbenchSnapshot`

Envelope leve retornado no bootstrap:

- `sessionId` e `revision`;
- identidade e status resumido da sessão;
- capabilities dos destinos;
- badges e severidades;
- objetivo, tasks/todos e processos resumidos;
- revisões conhecidas de contexto, execução, insights e configuração;
- cursor do último evento persistido;
- linked projects e projeto em foco quando aplicável.

### `SessionWorkbenchCapabilities`

Flags calculadas pelo backend, nunca inferidas apenas pela UI:

- `canShowContext`;
- `canShowExecution`;
- `canShowInsights`;
- `canShowPreview`;
- `canShowDiagram`;
- `canConfigureTools`;
- `canConfigureSkills`;
- `canManageSnapshots`;
- contribuições de plugin válidas para o projeto em foco.

### `SessionRailDestination`

```text
summary | context | execution | insights | canvas | configuration | plugin:*
```

Cada definição contém id, label, icon, group, capability, badge selector,
lazy loader, preferred width e comportamento em layout compacto.

### `SessionBadgeState`

Contagens pequenas e revisadas:

- notificações não lidas;
- erros/warnings de execução;
- subagentes ativos;
- capítulos;
- snapshots pendentes;
- configuração inválida ou indisponível.

### `SessionPanelViewState`

Estado visual não autoritativo, preservado por sessão/destino:

- aba interna;
- busca e filtros;
- expansões;
- cursor/página;
- scroll anchor;
- modo live/paused.

Esse estado não mantém payloads de domínio e não deve manter componentes
pesados montados.

## 3. Destinos e migração de conteúdo

| Destino novo | Conteúdo legado absorvido |
|---|---|
| Resumo | `meta`, objetivo, tasks, todos, active processes e notificações |
| Contexto | files, skill picks, Drive, chapters e plans |
| Execução | subagents, Worker Log e execution map |
| Insights | details/overview, telemetry, tool stats e captured inputs |
| Canvas | preview ou diagram, com modo amplo |
| Configuração | skills e tools por sessão |
| Ação de cabeçalho | snapshots |

- **CSW-IA-001** — O rail principal DEVE ter no máximo seis destinos Coder
  visíveis, além de plugins.
- **CSW-IA-002** — Conteúdo relacionado deve usar tabs ou seções internas, não
  ganhar novo ícone de primeiro nível.
- **CSW-IA-003** — Ação modal não pode fingir ser destino selecionável.
- **CSW-IA-004** — Destinos indisponíveis devem ser omitidos ou explicados;
  nunca abrir painel vazio.
- **CSW-IA-005** — O destino ativo deve permanecer reconhecível mesmo quando o
  rail estiver compacto.

## 4. Navegador de sessões

O navegador esquerdo possui estes conceitos:

- consulta paginada;
- busca textual;
- filtros de ativo/arquivado, status, provider e favorito;
- agrupamento por folder de projeto ou workspace global;
- seleção única para abertura;
- modo explícito de seleção múltipla;
- ações em lote com feedback e falhas parciais;
- presença de run, unread e status operacional sem consultar cada linha.

- **CSW-IA-006** — Group headers devem representar grupos retornados pelo
  backend, inclusive contagem total fora da página carregada.
- **CSW-IA-007** — Busca e filtros devem ser server-side.
- **CSW-IA-008** — Lista longa deve ser virtualizada sem quebrar navegação por
  teclado ou seleção em lote.
- **CSW-IA-009** — A seleção de itens deve sobreviver ao carregamento da página
  seguinte, mas ser limpa quando o escopo/filtro muda de modo incompatível.

## 5. Registry e plugins

- **CSW-IA-010** — Built-ins e plugins usam a mesma interface de definição.
- **CSW-IA-011** — Plugins não podem fornecer badge selector arbitrário que
  assine a store inteira.
- **CSW-IA-012** — O registry valida IDs, colisões, lado, capability e sandbox.
- **CSW-IA-013** — Desinstalar/desabilitar plugin ativo fecha o destino ou
  seleciona fallback determinístico.

## 6. Regras de seleção

1. Selecionar destino fechado abre o dock.
2. Selecionar o destino ativo fecha o dock, exceto em modo obrigatório de
   Canvas.
3. Trocar sessão preserva preferência de destino, mas só a restaura quando a
   capability existir.
4. Preferência de Canvas é project-scoped; não vaza para sessão global.
5. Mobile abre sempre o último destino válido dentro da sheet.
6. Falha de lazy chunk mantém o shell e oferece retry.

# Tools e Capacidades do Codex

## Visão geral

Codex modela tools em camadas:

1. especificação serializável para o modelo/API;
2. descoberta/carregamento de tools;
3. handlers que validam input e constroem requisições;
4. runtimes que executam sob sandbox/aprovação;
5. eventos/itens persistidos para UI e histórico.

A camada compartilhada `codex_tools` reexporta tool spec, discovery, executor, payload, search, MCP e conversão para Responses API (`.referece/codex/codex-rs/tools/src/lib.rs:1-108`).

## ToolSpec

`ToolSpec` é o enum canônico serializável. Ele cobre (`.referece/codex/codex-rs/tools/src/tool_spec.rs:13-53`):

- `function`;
- `namespace`;
- `tool_search`;
- `image_generation`;
- `web_search`;
- `custom` freeform.

A conversão para Responses API simplesmente serializa os specs em JSON values (`.referece/codex/codex-rs/tools/src/tool_spec.rs:77-91`). O spec de web search carrega opções como `external_web_access`, `index_gated_web_access`, filtros, localização do usuário, tamanho de contexto e content types (`.referece/codex/codex-rs/tools/src/tool_spec.rs:30-50`).

## ToolDefinition

`ToolDefinition` é metadado intermediário para crates downstream adaptarem tools em specs de alto nível (`.referece/codex/codex-rs/tools/src/tool_definition.rs:4-13`). Campos:

- `name`;
- `description`;
- `input_schema`;
- `output_schema` opcional;
- `defer_loading`.

Há helpers para renomear e marcar uma tool como deferred, removendo output schema (`.referece/codex/codex-rs/tools/src/tool_definition.rs:15-25`).

## Descoberta de tools e plugins

A descoberta define nomes built-in: `tool_search`, `list_available_plugins_to_install`, `request_plugin_install`; o limite padrão de busca é 8 (`.referece/codex/codex-rs/tools/src/tool_discovery.rs:5-10`).

Tools descobríveis são separadas em `Connector` e `Plugin`, com tipo, id, nome e install URL (`.referece/codex/codex-rs/tools/src/tool_discovery.rs:31-65`). Para o cliente TUI `codex-tui`, a lista de install filtra plugins (`.referece/codex/codex-rs/tools/src/tool_discovery.rs:79-91`). Informações de plugin incluem `has_skills`, nomes de MCP servers e app connector ids (`.referece/codex/codex-rs/tools/src/tool_discovery.rs:93-145`).

## Tool search

O handler built-in `tool_search` usa BM25 com cache sobre entradas `ToolSearchInfo`; rejeita query vazia e `limit=0` (`.referece/codex/codex-rs/core/src/tools/handlers/tool_search.rs:25-179`). O spec usa `TOOL_SEARCH_DEFAULT_LIMIT` e indexa `search_text` das tools (`.referece/codex/codex-rs/core/src/tools/handlers/tool_search.rs:68-94`). Hits múltiplos são coalescidos de volta em `LoadableToolSpec` (`.referece/codex/codex-rs/core/src/tools/handlers/tool_search.rs:173-180`).

## Exec e shell tools

Existem duas superfícies principais:

- `exec_command`: tool mais rica, paralelizável, com PTY/yield/output options;
- `shell_command`: tool shell mais simples, legado/compatível.

`exec_command` anuncia chamadas paralelas e deriva spec a partir do ambiente/opções (`.referece/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:80-104`). O handler resolve ambiente do turno, valida diretório de trabalho e convenção de path, recusando convenções estrangeiras salvo tentativa unsandboxed (`.referece/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:129-178`). Ele seleciona shell do ambiente ou shell do usuário e restringe overrides remotos ao tipo reportado pelo ambiente (`.referece/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:193-230`).

Permissões concedidas no turno e aprovações são combinadas; pedidos adicionais passam por feature flags e approval policy (`.referece/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:254-311`). Antes da execução normal, o handler pode interceptar chamadas a `apply_patch` (`.referece/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs:314-328`).

### Spec de shell

`CommandToolOptions` controla se login shell e parâmetros de aprovação aparecem no spec (`.referece/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:7-27`). `exec_command` inclui campos `cmd`, `workdir`, `tty`, `yield_time_ms`, `max_output_tokens`, `shell`, `login` e approval parameters; no Windows adiciona orientação de shell (`.referece/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:21-108`). `shell_command` tem interface menor: `command`, `workdir`, `timeout_ms` (`.referece/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:154-222`).

### Runtime de shell

`ShellRuntime` executa requests sob orquestrador, pede aprovação quando necessário, monta inputs de sandbox e executa no `SandboxAttempt` atual (`.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:1-6`). A requisição carrega command, environment, shell type, cwd, timeout, env, network proxy, sandbox permissions, additional permissions, justification e exec approval requirement (`.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:54-72`).

As aprovações são cacheadas por environment id, comando canonicalizado, cwd, sandbox permissions e additional permissions (`.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:94-101`, `.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:129-137`). Se há guardian review id, a decisão passa por `review_approval_request`; caso contrário, usa cache e `request_command_approval` (`.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:139-193`).

A execução monta network approval spec, preserva denied reads, injeta env compatível com sandbox, aplica path prepends, snapshots de shell, ajustes PowerShell/Windows sandbox e finalmente constrói comando sandboxed para `execute_env` (`.referece/codex/codex-rs/core/src/tools/runtimes/shell.rs:212-335`).

## request_permissions

`request_permissions` é uma function tool para solicitar permissões de filesystem/network com `reason`, `environment_id` e schema de permission profile aninhado (`.referece/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:224-340`). O schema separa objetos opcionais de network e filesystem; são payloads de pedido, não grants imediatos (`.referece/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:343-412`).

## apply_patch

`apply_patch` é tool freeform, explicitamente documentada como edição de arquivo que **não** deve ser envolvida em JSON (`.referece/codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:7-26`). Quando environment ids estão ativos, a gramática Lark aceita cabeçalho `*** Environment ID: ...` (`.referece/codex/codex-rs/core/src/tools/handlers/apply_patch_spec.rs:10-26`).

O runtime assume que verificação/aprovação ocorreu upstream e usa o filesystem do ambiente de turno sob sandbox (`.referece/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:1-6`). Aprovações são chaveadas por `(environment_id, path)`; sandbox context inclui permissões, cwd, workspace roots e campos Windows (`.referece/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:77-118`). O runtime pode pedir aprovação por guardian review ou cache, ajustando payloads para apontarem para `apply_patch` (`.referece/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:121-232`). A execução chama `codex_apply_patch::apply_patch`, registra deltas commitados e mapeia sandbox-denied para erro de protocolo (`.referece/codex/codex-rs/core/src/tools/runtimes/apply_patch.rs:235-287`).

## MCP tools

Conversão de MCP tools normaliza `properties` ausente/nulo para objeto vazio antes do parse e encapsula output em schema com `content`, `structuredContent`, `isError` e `_meta` (`.referece/codex/codex-rs/tools/src/mcp_tool.rs:6-36`).

A config runtime de MCP é construída de config + plugin registrations + overlays de extensão. Também injeta servidor legado `codex-apps` quando apps estão habilitados e mescla connector sources de plugins (`.referece/codex/codex-rs/core/src/mcp.rs:73-215`). Contribuições de extensão são ordenadas globalmente e incluem overlays `Set`/`Remove`, `SelectedPlugin` e `SelectedPluginConnectors` (`.referece/codex/codex-rs/core/src/mcp.rs:104-197`).

## Skills

`core::skills` reexporta `codex_core_skills`: service, loader, render, injection, policies e builders (`.referece/codex/codex-rs/core/src/skills.rs:11-35`). Invocações implícitas são detectadas a partir de skills carregadas e command/workdir do turno; são deduplicadas por `scope:path:name` antes de telemetry/analytics (`.referece/codex/codex-rs/core/src/skills.rs:48-109`).

## Web search

O core deriva detalhes de web search a partir do conteúdo da action, preferindo query explícita, primeira query da lista, URL ou pattern para open/find page (`.referece/codex/codex-rs/core/src/web_search.rs:3-39`).

## Image generation

A extensão de image generation usa modelo `gpt-image-2` e expõe tool namespaced `image_generation` com `ToolExposure::Direct` (`.referece/codex/codex-rs/ext/image-generation/src/tool.rs:53-103`). Ela emite itens in-progress/completed/failed, salva output opcionalmente e constrói hint de display com path do artefato (`.referece/codex/codex-rs/ext/image-generation/src/tool.rs:111-196`).

O modo generate/edit é escolhido por presença de imagens referenciadas ou recentes. Limite de edit: 5 imagens; exige imagens referenciadas ou imagens recentes, não ambas (`.referece/codex/codex-rs/ext/image-generation/src/tool.rs:229-298`). A seleção de imagens recentes percorre histórico para trás e diferencia inputs, outputs de function/custom tools e resultados prévios de image generation (`.referece/codex/codex-rs/ext/image-generation/src/tool.rs:300-353`).

## Goals

Goals são tools separadas `Get`, `Create`, `Update`, cada uma com nome plain e spec próprio (`.referece/codex/codex-rs/ext/goal/src/tool.rs:30-160`). Criação valida objetivo e budget, recusa segundo objetivo inacabado, atualiza accounting/analytics/telemetry e emite evento de turno (`.referece/codex/codex-rs/ext/goal/src/tool.rs:180-291`). Update aceita apenas estados terminais como complete/blocked e atualiza métricas/eventos (`.referece/codex/codex-rs/ext/goal/src/tool.rs:303-368`).

## File search na TUI

O `@` file search da TUI é session-based: uma sessão `codex-file-search` por search root, atualizada a cada mudança de query e encerrada quando query fica vazia (`.referece/codex/codex-rs/tui/src/file_search.rs:1-134`).

## Pontos notáveis

- Tools são first-class no contrato de modelo/API e no app-server.
- Exec/shell e apply_patch passam por sandbox e approval de forma explícita.
- `exec_command` pode interceptar apply_patch, aproximando tool freeform e shell.
- MCP/plugins/skills entram na composição de tools e instruções.
- O design separa descrição, roteamento, runtime e UI/eventos.

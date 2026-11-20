# Ferramentas e tipos de agentes do CodeStudio

Inventário de nomes conferido no checkpoint anterior à remoção do runtime, em 23/10/2026. A execução atual é TypeScript; as contagens foram ajustadas em 27/10/2026 para a remoção da funcionalidade Meta. Escopo: definições do produto; não consulta credenciais nem presume quais agentes personalizados, plugins ou servidores externos estão habilitados no perfil do usuário.

O catálogo principal possui **229 nomes** em **230 definições** (244/245 no inventário de 23/10/2026, menos sete nomes do Coder aposentados em nov/2026: `create_file`, `multi_edit`, `todo_write`, `update_todo`, `submit_tasks` e os recursos MCP `mcp_list_resources` e `mcp_read_resource`, que saíram com a ponte MCP; e menos os quatro nomes que só o servidor MCP publicava, removido com ele: `mcp__index_project`, `mcp__export_docs`, `mcp__start_agent_run` e `mcp__cancel_agent_run`; e menos as quatro leituras de execuções de agente, aposentadas com a API de execuções do aplicativo: `mcp__list_agents`, `mcp__list_agent_runs`, `mcp__get_agent_run` e `mcp__get_agent_result`). Nomes de compatibilidade e superfícies diferentes são contados separadamente. A definição de `respond_to_inbox` aparece em dois papéis Company, mas conta como um nome.

## Separação por superfície

| Superfície | Nomes |
| --- | ---: |
| Coder | 117 |
| Company e App Studio | 77 |
| DocsAgent | 6 |
| Tools de índice (`mcp__*`) | 25 |
| Skills | 4 |
| **Total** | **229** |

A composição efetivamente disponível depende do preset, perfil de ferramentas, permissões, capacidades registradas e contexto da sessão. Não se fornecem automaticamente as 229 ferramentas a todos os agentes.

## Todas as ferramentas do catálogo principal, por função

### Coder

**Arquivos e imagens (8).** Ler, localizar, criar, editar, mover e excluir caminhos; inspecionar imagens.

`read_file`, `list_directory`, `glob`, `view_image`, `write_file`, `edit_file`, `apply_patch`, `manage_path`.

`write_file` cria um arquivo novo (de forma exclusiva quando a porta oferece criação exclusiva) ou substitui um existente. Substituir, assim como o `*** Add File:` do `apply_patch` sobre um caminho existente, exige que a sessão tenha lido ou escrito aquele conteúdo e que ele não tenha mudado; senão a chamada é recusada e nada é escrito. `edit_file` aceita uma troca (`old_string`/`new_string`) ou `edits`, um lote aplicado atomicamente no mesmo arquivo.

**Comandos e execução programática (5).** Comandos, sessões persistentes, stdin e chamadas programáticas de ferramentas.

`exec_command`, `run_command`, `write_stdin`, `list_sessions`, `code_exec`.

**Git e worktrees (8).** Inspecionar e registrar alterações; entrar e sair de worktrees.

`git_status`, `git_diff`, `git_log`, `git_add`, `git_commit`, `git_branch`, `enter_worktree`, `exit_worktree`.

**Diagnósticos e LSP (5).** Erros, definições, referências e informações de símbolos.

`get_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_diagnostics`.

**Web e HTTP (3).** Pesquisar fontes, extrair páginas e executar requisições HTTP.

`web_search`, `web_fetch`, `http_request`.

**Navegador de pesquisa (8).** Navegação anônima em páginas HTTPS públicas, com restrições de rede e efeitos.

`browser_open`, `browser_snapshot`, `browser_extract`, `browser_click`, `browser_fill`, `browser_press`, `browser_screenshot`, `browser_close`.

**Preview Electron do aplicativo (22).** Janela do projeto com CDP: interação, inspeção visual, console, rede, CSS e desempenho.

`preview_open`, `preview_close`, `preview_navigate`, `preview_snapshot`, `preview_screenshot`, `preview_click`, `preview_double_click`, `preview_right_click`, `preview_hover`, `preview_fill`, `preview_type`, `preview_press`, `preview_scroll`, `preview_wait_for`, `preview_viewport`, `preview_eval`, `preview_console`, `preview_network`, `preview_inspect_css`, `preview_storage`, `preview_memory`, `preview_performance`.

**Bancos de dados (4).** Listar conexões, inspecionar esquema, consultar e executar comandos autorizados.

`db_list`, `db_schema`, `db_query`, `db_command`.

**Cliente de APIs (7).** Importar OpenAPI, organizar requisições e executar/verificar requests e coleções.

`api_import_openapi`, `api_list_requests`, `api_get_request`, `api_run_request`, `api_update_request`, `api_mark_verified`, `api_run_collection`.

**Diagramas (5).** Criar, ler, atualizar, listar e exportar diagramas.

`diagram_create`, `diagram_read`, `diagram_update`, `diagram_list`, `diagram_export`.

**Documentação e pesquisa aprofundada (4).** Consultar documentação indexada e delegar pesquisa com revisão de evidências.

`rag_search_docs`, `rag_read_doc`, `rag_doc_outline`, `docs_deep_research`.

**Interação, planos e especificações (5).** Perguntas, decisões e submissão/leitura de planos e especificações.

`ask_user`, `decision_gate`, `submit_plan`, `submit_spec`, `read_plan`.

**Tarefas (7).** Listas e itens de trabalho, atualização, cancelamento, arquivo e conclusão. `task_list` é a única lista: `gate:'track'` (checklist) ou `gate:'approve'` (lista aprovada que arma `execute_tasks`).

`task_list`, `list_tasks`, `update_task`, `cancel_tasks`, `delete_tasks`, `archive_task_list`, `task_complete`.

**Subagentes e coordenação (12).** Criar, acompanhar, retomar, conversar com filhos e executar tarefas/workflows.

`spawn_agent`, `resume_agent`, `request_review`, `read_agent_transcript`, `workflow`, `execute_tasks`, `list_agents`, `wait_agents`, `collect_agents`, `followup_task`, `send_input`, `send_message`.

**Revisão da sessão (1).** Revisar as alterações da sessão com o pipeline de revisão configurado.

`self_review`.

**Memória, notas e histórico (8).** Memória de projeto, notas de sessão e recuperação de investigações/conversas; memo de filho.

`remember`, `recall_memory`, `forget_memory`, `save_note`, `list_notes`, `recall_investigations`, `recall_conversation`, `record_memo`.

**Descoberta de ferramentas e resultados (4).** Consultar capacidades, expandir o catálogo ativo e recuperar saídas longas.

`capability_catalog`, `find_tools`, `expand_toolset`, `get_tool_output`.

**Criação de skills (1).** Criar uma skill reutilizável.

`create_skill`.

### Company e App Studio

**Supervisão dos subordinados (12).** Delegar, aguardar, interromper, retomar, aprovar e revisar o trabalho da equipe.

`spawn_subordinate_agent`, `list_subordinates`, `wait_for_subordinates`, `abort_subordinate_agent`, `resume_subordinate`, `finalize_subordinates`, `approve_subordinate_plan`, `approve_subordinate_plans`, `approve_subordinate_tasks`, `answer_subordinate_question`, `review_subordinate_work`, `recommend_role`.

**Comunicação e quadro compartilhado (11).** Inbox, mensagens entre papéis, comunicação com o master e estado da equipe.

`ask_master`, `send_to_agent`, `send_to_master`, `respond_to_inbox`, `read_my_inbox`, `check_inbox_answer`, `post_to_board`, `read_board`, `set_agent_status`, `forward_to_agent`, `broadcast_to_roles`.

**Submissões ao master (3).** Submeter planos, especificações e tarefas para o coordenador.

`submit_plan_to_master`, `submit_specification_to_master`, `submit_tasks_to_master`.

**Arquivos compartilhados (5).** Ler e manter o espaço de arquivos da equipe.

`read_shared_file`, `write_shared_file`, `append_shared_file`, `delete_shared_file`, `list_shared_files`.

**Kanban e dependências (13).** Cards, atribuições, revisão, objetivos, comentários e grafo de dependências.

`kanban_create_card`, `kanban_get_card`, `kanban_list_cards`, `kanban_move_card`, `kanban_move_to_review`, `kanban_assign_agent`, `kanban_add_dependency`, `kanban_remove_dependency`, `kanban_plan_graph`, `kanban_post_comment`, `kanban_read_my_card`, `kanban_update_meta`, `kanban_update_objectives`.

**Documentos do projeto/equipe (5).** Gerenciar documentos e seu índice; superfície distinta de docs_search do DocsAgent.

`docs_list`, `docs_read`, `docs_write`, `docs_delete`, `docs_index_update`.

**Ambiente (5).** Ler, definir, validar e remover entradas de configuração do ambiente.

`env_list`, `env_read`, `env_set`, `env_delete`, `env_validate`.

**Serviços, containers e sandbox (8).** Listar, iniciar, parar, reiniciar serviços e consultar logs.

`list_services`, `service_start`, `service_stop`, `service_restart`, `service_logs`, `list_containers`, `read_container_logs`, `read_sandbox_logs`.

**QA (3).** Iniciar verificação, obter endpoint do navegador e publicar resultado.

`qa_start_run`, `qa_get_browser_endpoint`, `qa_publish_result`.

**App Studio (11).** Estado e plano do app, banco, itens de trabalho, decisões e evidências de verificação.

`app_get_state`, `app_get_plan`, `app_update_plan`, `app_request_plan_approval`, `app_request_decision`, `app_get_db_state`, `app_update_database`, `app_upsert_work_items`, `app_dispatch_ready_work`, `app_record_work_evidence`, `app_run_checks`.

**Projetos da Company (1).** Consultar projetos disponíveis para a equipe.

`list_company_projects`.

### DocsAgent legado

**Ciclo interno do DocsAgent legado (6).** Planejar pesquisa, listar fontes, buscar, ler trechos, sintetizar e concluir.

`docs_plan`, `docs_list_sources`, `docs_search`, `docs_read_chunk`, `docs_synthesize`, `docs_finish`.

### Tools de índice (`mcp__*`)

**Leitura, busca e navegação de código (12).** Pesquisa textual/semântica e navegação estrutural no código indexado.

`mcp__search`, `mcp__grep_code`, `mcp__read_file`, `mcp__list_directory`, `mcp__get_file_skeleton`, `mcp__get_symbol_body`, `mcp__find_references`, `mcp__find_implementations`, `mcp__get_hierarchy`, `mcp__trace_usage`, `mcp__semantic_neighbors`, `mcp__prepare_edit`.

**Projeto (6).** Mapas, dependências, visão geral e atividade do projeto indexado.

`mcp__get_dependencies`, `mcp__get_dependents`, `mcp__get_project_overview`, `mcp__get_project_pulse`, `mcp__get_recently_modified_files`, `mcp__get_repo_map`.

**Documentação (3).** Pesquisar/ler documentação indexada e navegar o sumário.

`mcp__rag_search_docs`, `mcp__rag_read_doc`, `mcp__rag_doc_outline`.

**Memória do índice (2).** Salvar e pesquisar a memória do projeto.

`mcp__save_memory`, `mcp__search_memory`.

Dentro do Coder, as tools `mcp__*` de índice rodam no próprio processo, pela porta de tools de índice que os workers do Coder e da Company registram; não há processo filho nem stdio. Nome, descrição e schema vêm do catálogo da porta, em ordem alfabética. `mcp__index_project` e `mcp__export_docs` são ações da aplicação/CLI: o agente não as registra. Um processo sem porta registrada executa sem tools de índice e avisa a cada execução. Elas são `source: 'native'`, com procedência `kind: 'native'`, `providerId: 'code-indexer'` e `provenanceRef: 'index-native:code-indexer'`; o tempo-limite lento, a exclusão dos filhos Ultra isolados e o rótulo `mcp` nos contratos já publicados (evento operacional, hook `tool-filter` do projeto e listagem do `find_tools`) são regras explícitas em [index-tool-identity.ts](../../packages/code-agent/src/core/index-tool-identity.ts). No painel de tools elas aparecem com o selo "índice".

**Modelos e custos (2).** Consultar modelos e métricas de custo.

`mcp__list_models`, `mcp__get_costs`.

### Skills

**Skills (4).** Descobrir namespaces, listar skills, ler conteúdo e invocar uma skill.

`list_skill_namespaces`, `get_skills_list`, `get_skill_content`, `invoke_skill`.

## Distinções importantes das ferramentas

- `preview_*`: janela Electron do aplicativo local, com inspeção por CDP. `browser_*`: navegador de pesquisa para páginas públicas. `web_search`/`web_fetch`: pesquisa e extração sem o mesmo fluxo de interação visual.
- O prefixo `mcp__` marca as tools de índice dentro do Coder; a porta as publica sem o prefixo. `list_agents` é a da árvore de agentes; `mcp__list_agents` (catálogo de agentes do aplicativo) foi aposentada.
- `docs_*` da Company gerencia documentos de equipe; as seis `docs_*` do DocsAgent controlam seu ciclo de pesquisa; `rag_*` consulta documentação indexada. São superfícies distintas.
- Nomes aposentados não são aliases: `multi_edit`, `create_file`, `todo_write`, `update_todo`, `submit_tasks` e `poll_session` falham com a instrução da substituta (`edit_file` com `edits`, `write_file`, `task_list`, `write_stdin` com `chars` vazio), no nível principal e dentro do `code_exec`. O mesmo vale para `mcp__index_project`, `mcp__export_docs`, `mcp_list_resources` e `mcp_read_resource`, que apontam para `mcp__get_project_overview` e `mcp__get_repo_map`, e para as quatro leituras de execuções de agente (`mcp__list_agents`, `mcp__list_agent_runs`, `mcp__get_agent_run`, `mcp__get_agent_result`, também na forma `mcp__<projeto>__*`): a API de execuções saiu com o servidor MCP e não há substituta. `start_agent_run` e `cancel_agent_run` nunca foram registradas pelos agentes internos; uma chamada recebe o erro comum de tool desconhecida. Um `write_stdin` com `chars` vazio é uma leitura (poll), não uma escrita.

## Tipos de agentes, modos e extensões

### Agentes selecionáveis do Coder: 11 presets

São configurações do Coder, com prompt, catálogo inicial e regras próprias. Não são onze motores de execução diferentes.

| ID | Nome exibido | Função | Perfil inicial / regra |
| --- | --- | --- | --- |
| `explore` | Explore | Investigação e navegação de código | `bootstrap`; somente leitura: não publica nem autoriza ferramentas que alteram o workspace, executam processos ou delegam |
| `research` | Research | Pesquisa em documentos, web e navegador público | `bootstrap` + filtro de ferramentas de pesquisa |
| `plan` | Plan | Planejamento antes da implementação | `navigate`; plano aprovado antes de mutações |
| `build` | Code | Programação, edição, comandos e verificação | `navigate`; sem gate inicial de plano |
| `admin` | Ops | Operações privilegiadas | `full`; confirmação antes de operação irreversível |
| `spec` | Spec Doc | Especificação que orienta a implementação | `navigate`; especificação aprovada antes de mutações |
| `app_orchestrator` | App Coordinator | Coordenação persistente do App Studio, plano, Kanban e evidências | `navigate` |
| `app_db` | Database | Conexões, esquema, análise e manutenção de banco | `bootstrap`; mutações exigem aprovação |
| `builder` | UI Builder | Construção de frontend e edição a partir do preview | `navigate` |
| `api` | API Test | OpenAPI/Swagger, execução e verificação de endpoints | `navigate` + capacidades de API |
| `diagram` | Diagram | Criação e edição de diagramas Draw.io | `navigate` + capacidades de diagrama |

Fonte: [registro AGENTS](../../packages/code-agent/src/agents/index.ts#L72). `build`/Code e `builder`/UI Builder são entradas diferentes. O comentário antigo desse arquivo menciona quatro agentes, mas o registro efetivo possui onze.

### Subagentes: 5 perfis canônicos

| Perfil | Aliases aceitos | Finalidade |
| --- | --- | --- |
| `explore` | `investigate`, `investigator`, `readonly` | Investigar com o catálogo permitido de leitura/navegação |
| `implement` | `implementer`, `worker` | Implementar; ferramentas de escrita sujeitas ao escopo de caminhos |
| `verify` | `verifier` | Rodar verificações, comandos, testes e diagnósticos, sem ferramentas de edição |
| `review` | `reviewer` | Revisão focada de bugs, regressões e lacunas de testes |
| `full` | — | Herdar o catálogo exato permitido ao principal |

Fonte: [micro-agent-profiles](../../packages/code-agent/src/tools/micro-agent-profiles.ts#L59). A ausência de ferramentas de edição em `verify` não torna comandos de shell fisicamente incapazes de produzir efeitos.

`spawn_agent` seleciona esses perfis; `request_review` é uma especialização de revisão; `execute_tasks` organiza tarefas aprovadas; `workflow` organiza um grafo de dependências em execuções Ultra. `self_review` chama o pipeline de revisão de snapshots, não cria outro microagente.

O verificador de conclusão reutiliza `verify` com ferramentas restritas de revisão. Na implementação atual sua avaliação ocorre depois de persistir a conclusão e é consultiva: não pode negar nem revogar o objetivo. O texto antigo do catálogo de pipelines ainda descreve um bloqueio anterior à conclusão. Fontes: [hook atual](../../packages/code-agent/src/index.ts#L2627), [verificador](../../packages/code-agent/src/tools/verify-completion-subagent.ts#L248).

`kind=ephemeral` é o filho dedicado padrão. `kind=persistent` usa os subordinados Company quando esse contexto está disponível; fora dele existe um caminho de compatibilidade efêmero. Não se deve contar isso como um terceiro runtime de agentes.

### Company e App Studio

Company usa um `master` coordenador e subordinados com papéis configuráveis por template/sessão. Não existe uma quantidade fixa de papéis Company possíveis.

App Studio/App Team é uma especialização desse sistema e fornece nove presets:

| Papel | Função |
| --- | --- |
| `master` | Coordenar produto, plano, delegação e evidências |
| `research` | Pesquisar e reduzir incertezas |
| `architect` | Definir arquitetura, contratos e fronteiras |
| `backend` | Implementar servidor, APIs, domínio e integrações |
| `frontend` | Implementar interface, estados e integração |
| `database` | Cuidar de schema, consultas, índices e migrações |
| `ux` | Definir fluxos, usabilidade e acessibilidade |
| `qa` | Fazer verificação independente e regressões |
| `fullstack` | Implementar uma fatia funcional completa |

Fontes: [presets App Team](../../packages/api-handlers/src/app-studio/app-team-presets.ts#L35), [papéis configuráveis](../../packages/company-contracts/src/models/template.ts#L91), [worker Company](../../apps/http-api/workers/company-worker.ts#L6). Company/App Studio continuam no ciclo TypeScript legado. Os nove papéis não são nove runtimes nem ampliam os onze presets do Coder.

### Pesquisa documental: dois caminhos

| Caminho | Agentes / funcionamento | Runtime |
| --- | --- | --- |
| DocsAgent independente | Planejamento, fontes, busca, leitura, síntese e revisão; usa as seis tools `docs_*` listadas acima | `CoderRunner` TypeScript; rotas DocsAgent, Company e ponte legada |

Fonte: [DocsAgent](../../packages/docs-agent/src/index.ts).

### Agentes personalizados, plugins e MCP

- **Personalizados:** `custom:<id>`, herdando um dos onze presets e acrescentando prompt, skills, tiers, pins e allowlist. Podem ser criados pelo usuário ou gerenciados por extensão. A quantidade e os nomes dependem do perfil configurado. [Fonte](../../apps/http-api/custom-agents.ts#L10).

### Perfis, modos e runtime: eixos separados

| Eixo | Valores | O que controla |
| --- | --- | --- |
| Perfil do catálogo | `bootstrap`, `navigate`, `full` | Ferramentas inicialmente visíveis; `auto` resolve um desses perfis |
| Capacidade contextual | `company`, `sandbox`, `qa`, `app`, `master`, `preview`, `browser`, `api`, `diagram`, `db`, entre outras | Famílias liberadas pelo contexto e papel; visibilidade não substitui autorização |
| Modo da sessão | `standard`, `ultra` | Estratégia da execução e política de delegação |
| Delegação | `proactive`, `explicit_request_only` | Quando propor/criar frentes de subagentes |
| Execução de tarefas | `inline`, `all-subagent`, `smart`, `per-task` | Se cada tarefa roda no principal ou em um filho |
| Tipo de tarefa | `investigate`, `implement`, `verify` | Encaminhamento para os microperfis correspondentes |
| Profundidade de pesquisa | `quick`, `standard`, `deep`, `exhaustive` | Metas de exploração/síntese; não cria tipos de agente |
| Execução | TypeScript | Motor que executa a árvore de agentes |

Fontes: [tiers/perfis](../../packages/code-agent/src/tools/tiers.ts#L565), [modos](../../packages/session-storage/src/session-state-types.ts#L10), [tarefas](../../packages/code-agent/src/tools/execute-tasks/task-run-types.ts#L188), [roteamento](../../packages/agent-runtime-host/src/router/types.ts#L8).

A execução de Coder, Company e DocsAgent usa TypeScript. `full` pode nomear um perfil de catálogo ou um microperfil de subagente, dependendo do campo.

### Serviços auxiliares de IA: 18 bindings em 12 grupos

Esses bindings escolhem providers para funções específicas. Não correspondem a dezoito agentes autônomos.

| Grupo | Roles configuráveis | Função |
| --- | --- | --- |
| `indexer_search` | `hyde` | Expandir consultas |
| `snapshot_review` | `reviewer` | Revisar alterações/snapshots |
| `intent_contract` | `reviewer` | Converter intenção em obrigações verificáveis |
| `doc_ingest` | `classifier`, `scorer_llm`, `link_extractor` | Classificar, enriquecer e extrair links |
| `doc_search` | `rewriter` | Reformular consultas documentais |
| `docs_research` | `scorer_llm`, `classifier` | Controlar a pesquisa e síntese do DocsAgent legado |
| `memory_extraction` | `distiller` | Extrair memória durável |
| `memory_recall` | `reranker` | Filtrar lembranças pertinentes |
| `memory_query` | `query_writer` | Gerar consulta de memória |
| `code-agent` | `vision`, `transcription`, `preflight`, `compaction` | Etapas auxiliares do Coder |
| `editor` | `autocomplete` | Sugestões de código |

Fonte: [catálogo de pipelines](../../packages/services/src/pipelines/catalog.ts#L113). `docs_research` e o verificador de conclusão chegam a loops reais de agentes; isso não vale automaticamente para os demais bindings. `AgentSupervisor` é infraestrutura de heartbeat/recuperação. A antiga interface de pipelines executáveis de agentes foi removida pela [migração 265](../../packages/store/src/migrations/265_remove_agent_pipelines.ts#L6).

## Catálogos dinâmicos e extensões do checkout

MCPs externos, plugins e agentes personalizados variam conforme configuração e permissões. Seus catálogos efetivos não podem ser deduzidos apenas do inventário fixo de 229 nomes. Recursos e prompts MCP também não são contados como tools.

<!-- EXTENSION_CATALOG -->

## Fontes e conferência

- [Remoção do runtime e localização do checkpoint histórico](./runtime-retirement.md).
- [Definições das ferramentas Coder](../../packages/code-agent/src/tools/).
- [Definições das tools de índice](../../packages/indexer/src/agent-tools/tools/) e [documentação](../../packages/code-agent/src/tools/index-docs/docs.ts).


A classificação funcional foi conferida por igualdade de conjuntos: os 244 nomes do inventário de 23/10/2026 apareciam exatamente uma vez na seção principal e pertenciam à superfície declarada; as atualizações de nov/2026 só retiraram os sete nomes aposentados do Coder e os quatro nomes que só o servidor MCP publicava. Nenhum aplicativo ou provider foi iniciado para este levantamento.

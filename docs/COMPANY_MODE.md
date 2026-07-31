# Company Agents Mode — Modo Empresa de Agentes

O **Modo Empresa de Agentes** ("company mode") transforma uma sessão única em um **time
de agentes IA com papéis distintos**: um **Master** orquestra e **subordinados** executam,
trabalhando sobre um ou mais projetos. Cada papel pode rodar em um provider/modelo diferente,
seguir regras operacionais compartilhadas e colaborar por um quadro, Kanban, inbox e pipelines.

> **Documento bilíngue.** A Parte 1 está em **Português**; a Parte 2 (idêntica) em **English**.
> A interface respeita o idioma do app (locale `pt-BR` ou `en`) — os rótulos abaixo aparecem
> nas duas línguas onde ajuda.

**[🇧🇷 Parte 1 — Português](#parte-1--português)**  ·  **[🇬🇧 Part 2 — English](#part-2--english)**

---
---

# Parte 1 — Português

## Índice

1. [Visão geral](#1-visão-geral)
2. [Conceitos](#2-conceitos)
3. [Pré-requisitos](#3-pré-requisitos)
4. [Passo a passo](#4-passo-a-passo)
5. [Funcionalidades (painéis)](#5-funcionalidades-painéis)
6. [Como funciona por dentro](#6-como-funciona-por-dentro)
7. [Modelo de dados](#7-modelo-de-dados)
8. [Variáveis de ambiente](#8-variáveis-de-ambiente)
9. [Solução de problemas](#9-solução-de-problemas)
10. [Glossário e mapa de arquivos](#10-glossário-e-mapa-de-arquivos)

---

## 1. Visão geral

No chat tradicional, **um** agente conversa com você e mexe **em um** projeto. No Modo Empresa,
você monta um **time**:

- O **Master** é o orquestrador. Ele lê o quadro, **spawna subordinados**, aprova planos,
  responde perguntas e revisa entregas. Ele **não lê nem edita código diretamente** — delega.
- Os **subordinados** são os executores. Cada um recebe uma tarefa, trabalha em seu próprio
  contexto isolado, publica no quadro e move cards do Kanban.
- Tudo acontece dentro de uma **Sessão de Empresa**, que liga **um ou mais projetos**, um
  conjunto de **regras operacionais** e (opcionalmente) um **sandbox** em container para preview ao vivo.

**Quando usar.** Tarefas grandes ou multi-projeto, com fases paralelas (implementar + revisar +
QA + documentar), ou quando você quer modelos diferentes para papéis diferentes (ex.: um modelo
caro para o Master raciocinar, um barato para tarefas mecânicas). Para um ajuste pontual em um
arquivo, o chat único continua mais simples.

---

## 2. Conceitos

| Conceito | O que é | Onde vive |
|---|---|---|
| **Modelo / Template** | Blueprint **reutilizável** de papéis (Master + subordinados). Define quem existe e em que provider/modelo/tier cada um roda. Não está preso a nenhuma sessão. | Aba **Modelos** · tabela `company_templates` |
| **Empresa / Sessão** | Uma **instância** de trabalho: liga projetos, regras operacionais, pool de modelos e (opcional) sandbox. É aqui que os agentes rodam. | Botão **Nova Empresa** · tabela `company_sessions` |
| **Projetos** | As codebases sobre as quais o time trabalha. Uma sessão liga 1+ projetos. | Seção **Projetos** · tabela `company_session_projects` |
| **Papéis (Roles)** | "Cargos" do time. Exatamente **um** papel `master` é obrigatório; os demais são subordinados. | `roles_json` do template / `config_json` da sessão |
| **Regras operacionais** | Política em texto livre (markdown) injetada **verbatim** no prompt do Master e de **todo** subordinado. | Campo **Regras operacionais** |
| **Runtime / capability** | Define qual produto hospeda o lifecycle Company. `company` usa quadro/Kanban/pipelines; `app_studio` usa o workflow e as ferramentas do App. | `company_sessions.runtime_kind` |

### Papéis: Master × Subordinado

| | Master | Subordinado |
|---|---|---|
| Função | Orquestra, aprova, revisa | Executa tarefas concretas |
| Tier típico | `full` | `bootstrap` ou `navigate` |
| Lê/edita código? | **Não** (delega) | Sim |
| Env compartilhado | **Somente leitura** (`env_read`/`env_list`/`env_validate`) | Leitura **e** escrita |
| Spawna subordinados? | Sim | Não |

**Tiers de papel** (`bootstrap | navigate | full`): controlam o quanto de "ferramentas de
navegação/edição" o papel recebe. `bootstrap` = mínimo (tarefas rápidas e bem escopadas);
`navigate` = intermediário; `full` = conjunto completo. O Master usa `full`.

### Builder agora é feature de projeto

Sessões company sempre trabalham nos arquivos dos projetos ligados (requer **≥1 projeto**).
O antigo "Modo Builder" de sessão company foi **aposentado** — a experiência V0 (preview ao
vivo + seleção de elementos) virou feature de **projeto**: crie um projeto pelo wizard
**Novo Projeto → Modo Builder** e use sessões de chat normais sobre ele. Microsserviços em
container (Add Service) continuam disponíveis em qualquer sessão company.

### App Studio: equipe persistente hospedada pelo Company

Cada App possui **uma sessão Company especializada** (`runtime_kind = 'app_studio'`) e **um Master
ativo**. O App Studio continua dono da criação, das revisões, do workflow, das aprovações e dos
artefatos; o runtime Company fornece sessões persistentes por agente, histórico, inbox,
pause/resume/abort, reconexão e supervisão. A equipe também aparece em **Agents** com o badge
**App** e link de volta ao workflow.

O servidor resolve a capability a partir de `runtime_kind`:

- `company`: mantém o scheduler, o Kanban e as pipelines genéricas e **não** registra ferramentas
  `app_*`;
- `app_studio`: usa prompt, allowlists, política de autonomia e fonte de trabalho do App; não
  inicializa o scheduler Company nem usa Kanban/pipelines como uma segunda fila;
- o **workflow do App é a única fonte de cards**. A API `/api/app-studio` permanece como fachada e
  delega o lifecycle de agentes ao Company.

O transporte do App usa `/api/app-studio/sessions/:appId/team/*` para `start`, `resume`, `message`,
`answer`, `plan-response`, `abort`, `attach` e replay. O servidor resolve o vínculo App → Company e
nunca aceita o id da equipe informado pelo cliente. O painel App mantém uma única conexão SSE para
Chat/Agentes e invalida sessões, modelos efetivos e inbox a partir dos eventos reais. Em Agents, a
equipe App é uma projeção somente leitura: configuração, conversa e controles operacionais voltam
ao workflow do App. A projeção conserva somente Board e estado da equipe; oculta terminal, Env,
Inbox operacional, bancos, catálogo e superfícies de artefatos mutáveis. Mutações Company
incompatíveis retornam `APP_STUDIO_CONTROL_PLANE_OWNED`.

O preset editável nasce com Master `app_orchestrator` e especialistas `research`, `architect`,
`backend`, `frontend`, `database`, `ux`, `qa` e `fullstack`. Compatibilidade de nomes antigos:
`plan → architect`, `implement/implementer → fullstack` e `verify/verifier → qa`. O Master
coordena, decide e delega; **não edita código**. Especialistas recebem ferramentas de código e
somente as ferramentas `app_*` necessárias para ler contexto e registrar evidência do seu papel.

#### Modelo autoritativo por papel

Em qualquer spawn de um papel configurado, `role_assignments` é a fonte autoritativa para
provider, modelo, tier, reasoning, temperature, skills, prompt, fallbacks e os defaults de
thinking/budget. Uma execução pode ativar thinking para aquele turno, mas não trocar o runtime do
papel. Em equipes App, um papel inexistente, desabilitado ou sem provider/modelo explícito bloqueia
o card com erro de configuração. O override global `subagent_model` e parâmetros do despacho
**não** podem trocar o modelo do papel, e não existe fallback silencioso para o Master, para o pool
global ou para um modelo mini. Fallback só ocorre quando está explicitamente em `fallbackModels`.

Cada `company_agent_run` persiste o provider/modelo configurado e efetivo, a origem do despacho e
o motivo de fallback. Alterar um papel não muda um run em andamento; o próximo card usa a nova
configuração. Uma sessão `waiting` só é reutilizada quando papel, projeto e hash completo da
configuração continuam compatíveis.

O Master usa o mesmo contrato editável por meio dos campos `master_*` (enabled, provider/model,
tier, reasoning, temperature, thinking/budget, skills, prompt e fallback explícito). Seu tier
efetivo permanece `navigate` e a allowlist do Master continua removendo ferramentas de edição.
Quando uma falha transitória ativa `master_fallback_*`, o lifecycle atualiza primeiro a sessão e a
proveniência do mesmo `company_agent_run`, então retoma o transcript; não consulta o override
global nem inventa uma cadeia alternativa. Alterações no contrato do Master não mudam um runner
ativo: no próximo despertar, o lifecycle faz cold-resume do mesmo transcript, re-resolve o runtime
e aplica inclusive prompt e skills antes do primeiro turno.

#### Despacho, evidência e reconciliação

O scheduler App considera somente cards `ready` depois que dependências e aprovações foram
satisfeitas. Ele monta a primeira onda sem conflito de `file_scope`, respeita concorrência e cria
uma tentativa idempotente antes de marcar o card como `running`. Há histórico de várias tentativas,
mas somente uma tentativa ativa por card e por agente.

- evidência válida via `app_record_work_evidence` conclui a tentativa e mantém a progressão do
  workflow para revisão/conclusão;
- conclusão sem evidência, falha, interrupção ou aborto bloqueia o card e acorda o Master para
  recuperar ou reatribuir;
- **Pausar** preserva card e sessão; **Retomar** reutiliza a mesma sessão; **Cancelar/Abortar**
  atualiza deterministicamente tentativa, agente e card;
- após reinício, a reconciliação compara as tentativas ativas com `company_agent_runs` e repara
  estados divergentes. O despacho automático continua restrito a trabalho pronto e aprovado.

#### Adoção e compatibilidade de Apps existentes

A adoção é idempotente e espera o coordenador legado deixar de executar. Depois, cria/vincula a
sessão Company, adota o coordenador e seu transcript/modelo como Master e converte os perfis
configurados para `role_assignments`. Sub-runs antigos continuam visíveis separadamente como
**execuções legadas**; não viram agentes persistentes falsos. Durante a janela de compatibilidade,
`agent_config_json`, `coordinator_session_id`, `coder_session_id` e endpoints antigos continuam
legíveis, mas um App adotado deixa imediatamente de despachar por `execute_tasks`; chats solo não
mudam.

"Nova conversa" só rotaciona o Master quando ele está ocioso. O transcript anterior vira somente
leitura e os especialistas permanecem na mesma equipe. Excluir o App remove a equipe vinculada na
mesma operação; a rota Company rejeita a exclusão direta de uma sessão pertencente a um App.

---

## 3. Pré-requisitos

1. **Providers e modelos configurados** em **Admin → AI** (você precisa de pelo menos um provider
   com chave válida; o Master e cada papel escolhem dentre esses modelos).
2. **Projetos cadastrados/indexados**. Sem projetos, o seletor mostra
   *"Nenhum projeto indexado encontrado."*
3. **Podman ou Docker** instalado e acessível **somente se** você for usar
   microsserviços em container. O fluxo padrão não exige container.
4. *(Opcional)* **Skills** habilitadas em **Admin → Skills** — papéis podem ativar skills
   específicas (ex.: `qa-playwright`).

---

## 4. Passo a passo

### 4.1 Abrir o Modo Empresa

Abra a aba **"Modo Empresa de Agentes"**. Na primeira vez, a tela inicial traz o botão
**"Crie Sua Primeira Empresa"**. Depois, use **"Nova Empresa"** (canto da lista de Sessões).

A barra lateral tem duas abas: **Sessões** (instâncias em andamento) e **Modelos** (templates reutilizáveis).

### 4.2 (Opcional) Criar um Modelo (Template)

Um Modelo te poupa de reconfigurar papéis toda vez. **Aba Modelos → "Novo modelo"**:

1. **Nome** (ex.: *Time Web*) e **Descrição** (ex.: *Time de desenvolvimento web full-stack*).
2. **Papéis** — já vem com um papel **`master`** (ícone de coroa 👑, **obrigatório** e não removível).
   Clique em **"Adicionar Papel"** para cada subordinado.
3. Em cada papel, clique em **Editar** para abrir o editor de papel:
   - **Nome do papel** (vira minúsculas com `_`, ex.: `code_reviewer`).
   - **Provider** + **Modelo**.
   - **Fallback** de provider/modelo (auto-recuperação se o primário falhar).
   - **Nível (tier)**: Bootstrap / Navigate / Full.
   - **Temperature** (0–1; vazio = padrão do preset do agente).
   - **Raciocínio estendido** (extended thinking) + orçamento de tokens — só providers que
     suportam (Anthropic, Gemini); custa mais tokens.
   - **Habilidades (skills)** — agrupadas por origem (user / builtin / namespace de plugin).
   - **Pacotes MCP disponíveis** (somente leitura, não-master) — subordinados destravam sob demanda
     via `expand_toolset`.
   - **Sobrescrever system prompt** (markdown; suporta variáveis como `${PROJECT_NAME}`, `${SESSION_ID}`,
     `${USER_INPUT}`, `${OS}`, `${TIMESTAMP}`).
4. **Salvar**. (Persiste via `POST /api/company/templates`.)

> Regra: pelo menos um papel deve se chamar **"master"** — o editor avisa *"Pelo menos um papel
> deve se chamar 'master'."* caso falte.

### 4.3 Criar a Empresa (Sessão)

Clique em **"Nova Empresa"** para abrir o diálogo **"Iniciar Sessão de Empresa"**:

| Campo | Obrigatório | Observação |
|---|---|---|
| **Nome da Sessão** | Sim | ex.: *Feature Sprint Q2* |
| **Template (opcional)** | Não | Escolha um modelo, ou **"Custom (sem template)"**. Com template, o provider/modelo do Master e de cada papel ficam **travados** pelo template. |
| **Projetos** | Sim | Lista de checkboxes. |
| **Provider/Modelo do Master** | Sim | Desabilitado se um template foi escolhido (o template manda). |
| **Fallback do Master** | Não | Provider/modelo de reserva. |
| **Pool de modelos permitidos** | Não | Lista curada de `(provider, modelo)` que o Master pode usar ao spawnar. **Vazio = sem restrição.** Não-vazio = o servidor **rejeita** qualquer spawn fora do pool. |
| **Master observa peer-to-peer** | Não | Cada mensagem entre subordinados gera uma cópia *notify* para o Master (aparece como `[INBOX-OBSERVED]`). |
| **Regras operacionais** | Não | Markdown injetado verbatim em todo agente (ver §6). |

Clique em **"Criar & Iniciar"** (`POST /api/company/sessions`). A sessão aparece na lista e abre;
o Master sobe e fica **em standby**, pronto para sua primeira instrução — envie-a no composer (ver §4.6).

### 4.4 Vincular e gerenciar Projetos

- **Na criação**: marque os projetos na lista de checkboxes.
- **Depois**: no painel lateral de agentes, seção **Projetos**. Vincular/desvincular é dinâmico.
  - Projetos **reais**: ao desvincular, os **arquivos são preservados** no disco.
  - Projetos **virtuais** (`_builder_*`, criados por serviços em container): são **derrubados**
    por completo (remove o serviço e a linha do projeto).

### 4.5 Ajustar papéis depois da criação

No painel lateral de agentes:

- **Papéis Configurados** + **"Adicionar Papel"** — cria um papel novo só para esta sessão.
- **Editor de modelo por papel** — troca provider/modelo de um papel.
- **Agentes por projeto** — vincula papéis a projetos específicos (binding); um papel ligado a um
  só projeto resolve `project_id` automaticamente no spawn.
- **Regras operacionais** — editável aqui. Novos agentes pegam **na hora**; o Master em execução,
  no próximo *reestablish*.

### 4.6 Iniciar o trabalho

Use o composer (**"Envie uma mensagem para o Master..."**) para descrever o objetivo. O Master
decide o plano, spawna subordinados, e você acompanha tudo pelos painéis. Quando o Master submete
um **plano** ou faz uma **pergunta**, aparece um bloco para você **Aprovar/Responder**.

---

## 5. Funcionalidades (painéis)

A sessão usa um **layout de 3 zonas** (que **substituem** a área central) + um **drawer lateral**
de "espiada" (painéis que você quer **junto** do conteúdo central).

### Zona **Work** (trabalho do time)

As abas abaixo descrevem sessões `runtime_kind = 'company'`. Em equipes `app_studio`, **Kanban** e
**Pipelines** ficam ocultos: o painel oferece acesso ao workflow autoritativo do App, sem duplicar
cards entre produtos. Board, transcript e controles reais dos agentes continuam disponíveis.

| Aba | O que faz |
|---|---|
| **Quadro** (Board) | Feed compartilhado onde os agentes postam. Tipos de mensagem: *message, decision, question, deliverable, handoff, blocker*. Dá para copiar o quadro/mensagem em Markdown. |
| **Kanban** | Colunas **Pendências · A Fazer · Em Progresso · Revisão · Concluído**. Cards com objetivos, dependências, comentários e histórico de agente. |
| **Pipelines** | Workflows multi-estágio (ver abaixo). |
| **Transcrição** | Log histórico das mensagens entre agentes. |

**Pipelines** em detalhe: builder visual com **templates** de estágio (Investigar, Coletar
contexto, Implementar, Refatorar, Validar output, QA gate, Revisão humana, Resumir, Changelog,
Checkpoint, Classificar). Cada nó é um **Agente** ou um **Validador** (só decisão:
`submit_verdict({pass|fail|review})`). Arestas com modos **linear / pass-fail / by-tag /
by-text-match**. Opções por nó: **Máx. tentativas**, **override de modelo** (rode validadores num
modelo mais barato), e **Aprovação manual** (`requires_confirmation` — pausa para você aprovar
antes de avançar). Escopo: **sessão** (multi-projeto) ou **global**.

### Zona **Build** (artefatos que o time produz)

**Documentos** · **Tests** (QA Playwright em tempo real) · **Files** · **Git** (com **Push**) ·
**API** · **Terminal** (no **Sandbox** ou no **Host**) · **Runners**.

### Zona **Data** (persistência da sessão)

**Drive** (arquivos da sessão; anexar pastas) · **Snapshots** (revisões de código com findings) ·
**Arquivadas** (snapshots de reset) · **Indexados** (tabela de arquivos indexados por projeto) ·
**Vetores** (busca híbrida · vector · FTS com diagnóstico inline).

### Drawer lateral

| Painel | O que faz |
|---|---|
| **Preview** | Saída do dev server (HMR) de serviços em container. |
| **Inbox** | Fila de mensagens entre agentes (status: *pending, delivered, answered, cancelled, expired*). Você pode **cancelar** uma mensagem travada ou **"Responder como humano"** no lugar do destinatário. |
| **Env** | Variáveis de ambiente compartilhadas da sessão (ver abaixo). |
| **Bancos** | Visão somente leitura das conexões da aba Databases dos projetos vinculados (migration 174). O agente as acessa via `db_list`/`db_schema`/`db_query`/`db_command`; o cadastro/edição acontece no projeto, não na sessão. |
| **Supervisor** | Saúde dos agentes e incidentes (ver §6). |

**Env** em detalhe: variáveis injetadas como env do container **e** escritas em `/app/.env` de cada
microsserviço. Edições ao vivo sincronizam com os containers em execução. As vars são agrupadas por
origem: **Definidas pelo usuário**, **Definidas pelo agente**, **Importadas do .env** e
**Auto** (gerenciadas pelo sandbox/DB — edições podem ser sobrescritas). Segredos podem ser
mascarados. O **Master é somente leitura** em env; subordinados leem e escrevem.

### Sidebar de agentes

Mostra **Projetos**, **Papéis Configurados**, **Regras operacionais** e os **painéis de agentes**
ao vivo, com status (**Ocioso, Executando, Trabalhando, Aguardando, Revisão de Plano, Pergunta,
Revisão de Tarefas, Revisando, Bloqueado, Concluído, Erro, Abortado, Pausado**) e controles por
subordinado (**Pausar / Retomar / Excluir agente**).

### Métricas da sessão

O modal de métricas mostra: contagens de **mensagens** (Conversa / Tudo / Só usuário),
**Sumarizações duráveis** (automáticas e manuais), bloco de **TOKENS** (input/output/cache/thinking
+ hit ratio) e **Economia Real** (economia de cache, *shaping* de output e *tiering* de tools).

### Auto-revisão (self-review)

- **`self_review`** — o agente roda a pipeline `snapshot_review` sobre os próprios diffs; o nudge é
  controlado por `CODER_SELF_REVIEW`.
- **`review_subordinate_work`** (só Master) — revisa os snapshots de um subordinado e devolve
  *findings* por severidade. Os findings também aparecem no painel **Snapshots**. Para corrigir, o
  Master usa **`forward_to_agent`** para devolver a tarefa ao subordinado.

---

## 6. Como funciona por dentro

### Orquestração Master ↔ Subordinado

**Ferramentas do Master** (prefixos confirmados em `master-filter.ts`): `spawn_subordinate_agent`,
`wait_for_subordinates`, `list_subordinates`, `resume_subordinate`, `abort_subordinate_agent`,
`approve_subordinate_plan`, `answer_subordinate_question`, `approve_subordinate_tasks`,
`forward_to_agent`, `finalize_subordinates`, `list_company_projects`, `post_to_board`, `read_board`,
`set_agent_status`, `kanban_*`, `review_subordinate_work`. O Master **não** recebe `read_file`,
`grep_code`, `write_file` etc. — apenas tools de visão geral (`get_project_pulse`, `get_architecture`,
`list_directory`, `search`, `glob`) e de comunicação.

**`spawn_subordinate_agent`** — principais parâmetros: `role`, `task`, `project_id`,
`provider`/`model`/`tier`, `skills`, `wait` (bloquear até concluir) e `thinking`. Por padrão é
**assíncrono** (`wait=false`): o subordinado roda em segundo plano. Quando o papel existe em
`role_assignments`, seu runtime persistido é autoritativo; overrides de provider/modelo/tier do
despacho são ignorados.

**Ferramentas do subordinado** (não podem spawnar outros): `ask_master`, `submit_plan_to_master` /
`submit_specification_to_master`, `submit_tasks_to_master`, `send_to_agent`, `send_to_master`,
`read_my_inbox`, `check_inbox_answer`.

### Company worker

Cada sessão roda em um **`worker_thread`** dedicado. No boot, ele abre o SQLite em modo WAL e
**re-fia** os stores module-global via `db.raw()` (design system, QA, env) — necessário porque
singletons do processo principal ficam `null` no worker. Em seguida instancia o orquestrador, liga
o **AgentSupervisor**, espelha o `metaBus` e expõe RPC para o processo principal.

No boot, `runtime_kind` seleciona a capability do servidor. Sessões `company` iniciam o
`CompanyScheduler`; sessões `app_studio` iniciam somente o `AppStudioScheduler`, vinculado por
`app_studio_sessions.company_session_id`. Ambos compartilham o mesmo lifecycle persistente de
Master/subordinados, mas não compartilham uma fila de trabalho.

### AgentSupervisor (anti-travamento)

Ativado por **`MCP_SUPERVISOR_ENABLED=1`**. Faz *heartbeat tracking*, detecta agentes travados,
dispara recuperação e tem **três disjuntores (circuit breakers)**:

| Breaker | Gatilho (padrão) | Efeito |
|---|---|---|
| Por agente | 3 falhas de recuperação em 10 min | Agente em quarentena |
| Por papel | 3 falhas do mesmo papel em 10 min | Papel em quarentena por 5 min (sem novos spawns) |
| Global | 20 incidentes em 1 min | Modo **somente-leitura** por 1 min (só registra, não recupera) |

O **`RuntimeReconciler`** (varredura de **45s**, `MCP_COMPANY_RECONCILE_MS`) reconcilia o
`status` no banco com o estado real do runtime e **re-cutuca** o Master quando uma decisão fica
parada (cadência **30s**, `MCP_COMPANY_MASTER_NUDGE_MS`, `0` desliga).

### Wait/wake loop

O Master "dorme" em `wait_for_subordinates` e acorda por **`MasterAttention.signal`** (tipos:
*question, plan, tasks, finished, inbox_answered, user_message, notify*). O laço combina disparo por
**nível** (checa pendências antes de dormir) e por **borda** (evento), com um *safety poll* de 2s
para nunca perder um sinal. Subordinados que esperam o Master têm um fallback de **30 min**
(`MCP_SUBORDINATE_MASTER_WAIT_MS`).

### Regras operacionais

São injetadas **verbatim** no system prompt do Master e de **todo** subordinado, **a cada**
start/spawn/resume. São lidas **fresh** do `config_json` (não ficam em cache) e têm **cap de
16.000 caracteres** (acima disso, são truncadas com aviso). Por viverem no system prompt,
sobrevivem a reativações e compactações.

### Tiers de tools

- **`COMPANY_TOOLS`** — registradas em **toda** sessão de empresa: shared drive
  (`read/write/append/delete/list_shared_file`), comunicação (`send_message`, `list_agents`,
  `wait_agents`, inbox), e env (`env_list/read/set/delete/validate` — Master só lê).
- **`BUILDER_TOOLS`** — só quando há binding de sandbox (subordinado ligado a serviço em
  container): `db_*`, `docs_*`, controle de sandbox/pipeline/serviços.
- **`APP_TOOLS`** — registradas somente quando `runtime_kind = 'app_studio'` e filtradas por
  audiência (Master ou papel especialista). Sessões Company comuns nunca recebem `app_*`, e uma
  tool externa não pode se apresentar como capability nativa do App.

### Pool de modelos e concorrência

- O **pool de modelos permitidos** é validado no spawn — `(provider, modelo)` fora do pool é rejeitado.
- Um único resolver de runtime atende os despachos de especialistas por Master, caminho manual,
  scheduler, pipeline, fan-out, retry e App. Para papel configurado, o pool só valida a escolha
  persistida; não substitui essa escolha. Em App, fallback vem exclusivamente da lista explícita
  do papel. O Master usa o runtime persistido próprio da sessão.
- **Concorrência**: no máximo **10** subordinados simultâneos (`CODER_COMPANY_MAX_SUBORDINATES`);
  ao estourar, o spawn pede para o Master chamar `wait_for_subordinates`.
- **Retries** automáticos de subordinado: **1** (`CODER_SUBORDINATE_MAX_RETRIES`).

---

## 7. Modelo de dados

Tabelas centrais (migration `018_company_agents.ts`):

| Tabela | Colunas-chave |
|---|---|
| `company_templates` | `id`, `name`, `description`, `roles_json`, `created_at`, `updated_at` |
| `company_sessions` | `id`, `template_id` → templates, `runtime_kind` *(`company`/`app_studio`)*, `name`, `status` *(idle/running/paused/completed/error)*, `master_session_id` → `coder_sessions`, `config_json` (default `{}`), timestamps |
| `company_session_projects` | PK (`company_session_id`, `project_id`), `label` *(null = projeto real; preenchido = serviço virtual `_builder_*` — prefixo herdado de sessões legadas)* |
| `company_agent_runs` | `id`, `company_session_id`, `role`, `coder_session_id`, `project_ids_json`, `configured_provider/model`, `provider/model` efetivos, `dispatch_source`, `fallback_reason`, `status`, timestamps |
| `company_board` | `id`, `company_session_id`, `author_role`, `agent_run_id`, `kind` (default `message`), `content`, `mentions_json`, `created_at` |

**`config_json`** (na `company_sessions`) carrega: `role_assignments[]`, `allowed_models[]`,
`operational_rules` (string) e `master_broadcast_subscribe` (bool). (Sessões legadas podem
carregar uma chave `builder` do modo aposentado — ignorada pelo runtime atual.)

Tabelas adicionais por migrations posteriores: `034` sandbox, `035` serviços, `036` env vars
(`company_session_envs`), `038` arquivos (`company_archives`), `065` frentes, `067` sub-sessões,
`085` fundação de pipelines. (A tabela `company_session_databases` da migration `040` foi
aposentada na `191` — conexões agora são por projeto, migration `174`.)

A migration `235_app_studio_company_runtime.ts` adiciona a integração App:

| Tabela/coluna | Papel |
|---|---|
| `app_studio_sessions.company_session_id` | vínculo 1:1 com uma sessão Company `runtime_kind = 'app_studio'` |
| `app_studio_work_item_runs` | histórico card/tentativa/papel ↔ `company_agent_run`, coder session, status, hash de configuração e chave idempotente |

Índices parciais garantem no banco somente uma tentativa ativa por card e somente um card ativo por
`company_agent_run`. Triggers validam que o agente pertence à equipe e ao papel informados. A
exclusão do App apaga primeiro seus vínculos e depois a sessão Company; `ON DELETE RESTRICT` impede
que a equipe seja removida por fora enquanto ainda pertence ao App.

**Rotas HTTP** (sob `apps/http-api/server/routes/company/`): `GET/POST /api/company/templates`,
`PATCH/DELETE /api/company/templates/:id`, `GET/POST /api/company/sessions`,
`.../sessions/:id/projects`, além de `board`, `kanban`, `pipelines`, `envs`, `databases`, `drive`, `sandbox`.
As rotas sob `/api/app-studio/sessions/:id/agents` e `/workflow` são a fachada do App para
configuração de papéis, sessões/transcripts, dispatch e lifecycle. Respostas expõem
`company_session_id`, Master/equipe, provider/modelo configurado e efetivo e runs legados separados.
O lifecycle/stream real entra exclusivamente por
`/api/app-studio/sessions/:id/team/{state,state-snapshot,attach,start,resume,message,answer,plan-response,wake-master,abort}`.
O servidor resolve e valida o vínculo App ↔ Company antes de delegar; `attach`, `start` e `resume`
preservam o stream multiplexado, `Last-Event-ID`, replay e idempotência do runtime Company. A UI do
App não chama `/api/company` diretamente. Eventos `agent_status` de equipes App carregam também
provider/modelo configurado e efetivo, origem do despacho e motivo de fallback.

---

## 8. Variáveis de ambiente

> Defaults conferidos no código. Tudo é opcional — os valores padrão já entregam o comportamento atual.

| Variável | Padrão | Efeito |
|---|---|---|
| `CODER_COMPANY_MAX_SUBORDINATES` | `10` | Máx. subordinados simultâneos (fallback legado: `COMPANY_MAX_CONCURRENT_SUBORDINATES`). |
| `CODER_SUBORDINATE_MAX_RETRIES` | `1` | Retries automáticos de um subordinado que falha. |
| `MCP_SUBORDINATE_MASTER_WAIT_MS` | `1800000` (30 min) | Fallback de espera do subordinado pela decisão do Master. |
| `MCP_SUPERVISOR_ENABLED` | *off* | `1` liga o AgentSupervisor (anti-travamento). |
| `MCP_SUPERVISOR_PERSISTENCE` | *on* | `0` desliga a persistência de incidentes em SQLite. |
| `MCP_SUPERVISOR_AGENT_BREAKER_LIMIT` / `_WINDOW_MS` | `3` / `600000` | Disjuntor por agente. |
| `MCP_SUPERVISOR_ROLE_BREAKER_LIMIT` / `_WINDOW_MS` | `3` / `600000` | Disjuntor por papel. |
| `MCP_SUPERVISOR_ROLE_QUARANTINE_MS` | `300000` (5 min) | Quarentena do papel. |
| `MCP_SUPERVISOR_GLOBAL_BREAKER_LIMIT` / `_WINDOW_MS` | `20` / `60000` | Disjuntor global. |
| `MCP_SUPERVISOR_GLOBAL_READ_ONLY_MS` | `60000` (1 min) | Duração do modo somente-leitura. |
| `MCP_COMPANY_RECONCILE_MS` | `45000` | Cadência da varredura do `RuntimeReconciler` (mín. 1s). |
| `MCP_APP_STUDIO_SCHEDULER_TICK_MS` | `10000` | Cadência do scheduler especializado do App (mín. 2s; só `runtime_kind = 'app_studio'`). |
| `MCP_COMPANY_MASTER_NUDGE_MS` | `30000` | Re-cutucada do Master parado; `0` desliga. |
| `MCP_COMPANY_INBOX_WATCHDOG_ENABLED` | *off* | `1` liga o watchdog de inbox. |
| `MCP_COMPANY_INBOX_MAX_PENDING` | `3` | Máx. de mensagens pendentes por destinatário. |
| `MCP_COMPANY_INBOX_STALE_IDLE_MS` | `300000` (5 min) | Limite de inatividade para considerar a inbox "stale". |
| `MCP_COMPANY_INBOX_WAIT_TIMEOUT_MS` | `1200000` (20 min) | Timeout de espera de uma mensagem de inbox. |
| `CODER_SELF_REVIEW` | *off* | Liga/desliga o nudge de auto-revisão opt-in. |

### 8.1 Flags de autonomia (C2 — organismo ligado por padrão)

> Precedência: **sessão** (`config_json.autonomy.*`, painel de Autonomia / PATCH `/config`) >
> **env** > **default**. `autonomy.freeze: true` na sessão zera TODAS as ações autônomas ao vivo
> (checado a cada tick/uso, sem reiniciar o worker).

| Variável | Padrão | Efeito |
|---|---|---|
| `MCP_COMPANY_SCHEDULER` | *on* | Kill-switch do scheduler autônomo E do reset de cards órfãos: `0` desliga (`1` segue ligando, no-op de back-compat). Por sessão: `autonomy.scheduler` / `autonomy.orphanReset`. |
| `MCP_COMPANY_AUTO_APPROVE_ROLES` | `*` (todos os papéis) | Se PRESENTE, sobrepõe o default: csv = allowlist, `*` = todos, string vazia = ninguém auto-aprova. Por sessão: `autonomy.autoApproveRoles` (lista, `'*'` ou `null`). |
| `MCP_SUPERVISOR_MASTER` | *on* | Kill-switch do supervisor do Master: `0` desliga. Seguro por padrão — os waits longos fazem heartbeat (`agent-wait-loop`/`await-master`). Por sessão: `autonomy.supervisorMaster`. |
| `MCP_COMPANY_GLOBAL_MAX_SUBORDINATES` | `8` | Budget GLOBAL de subordinados (contagem cross-session): int>0 = teto, `0` = sem limite, ausente/inválido = 8. Por sessão: `autonomy.maxSubordinates` (int>0; `null` = volta à política padrão — NÃO significa "sem limite"). |

---

## 9. Solução de problemas

- **Sessão parada / "Sessão parada"** — o banner *"X min sem progresso"* aparece quando o Master
  pode estar bloqueado numa tool ou aguardando humano. Clique em **Continuar**. Para detecção e
  recuperação automáticas, ligue **`MCP_SUPERVISOR_ENABLED=1`**.
- **Master não acorda** — use **"Acordar agora"** no banner de standby. Se decisões ficam paradas,
  confirme que `MCP_COMPANY_MASTER_NUDGE_MS` não está em `0`.
- **Spawn rejeitado** — causas comuns: (a) **teto de concorrência** (10) — o Master deve chamar
  `wait_for_subordinates`; (b) **fora do pool** — *"Modelo 'x/y' não está no pool permitido da
  sessão"*; (c) **papel em quarentena** por um disjuntor do supervisor.
- **Card App bloqueado antes do spawn** — confira se o papel existe, está habilitado e tem
  provider/modelo explícitos. O runtime App bloqueia configuração inválida em vez de herdar
  `subagent_model`, o modelo do Master ou um modelo mini.
- **Especialista App terminou, mas o card bloqueou** — o run terminou sem evidência aceita. Abra o
  transcript do especialista, corrija a causa e retome/reatribua; o especialista deve chamar
  `app_record_work_evidence` antes de concluir.
- **App mostra "migração pendente"** — o coordenador legado ou o Master atual ainda está rodando.
  Aguarde-o ficar ocioso e recarregue; a adoção é idempotente e não executa duas equipes em paralelo.
- **Variável de ambiente não aparece / tool de env falha** — geralmente é o store não fiado no
  worker; o boot do company-worker re-fia via `db.raw()`. Confira a aba **Env** e a origem da var.
- **Master terminou com erro / parou inesperadamente** — os banners pedem **enviar uma mensagem
  para retomar**; a sessão é reaberta do ponto em que parou.

---

## 10. Glossário e mapa de arquivos

**Glossário.** *Master* = agente orquestrador. *Subordinado* = agente executor. *Template/Modelo* =
blueprint de papéis. *Sessão/Empresa* = instância de trabalho. *Tier* = nível de ferramentas de um
papel. *Regras operacionais* = política injetada em todos os agentes. *Quadro/Board* = feed do
time. *Pool de modelos* = lista permitida de provider/modelo.

**Mapa de arquivos (para devs).**

| Área | Caminho |
|---|---|
| Criar empresa (UI) | `apps/dashboard/features/agents/NewCompanyDialog.tsx` (+ `new-company-dialog/`) |
| Criar template (UI) | `apps/dashboard/features/agents/{TemplateBuilderModal,RoleEditModal,TemplateListPanel}.tsx` |
| Sidebar / papéis / regras | `apps/dashboard/features/agents/session-view/`, `OperationalRulesEditor.tsx` |
| Zonas e abas | `apps/dashboard/features/agents/zones/` · `preview-sidebar/` |
| Contratos | `packages/company-contracts/src/models/{template,pipeline}.ts` |
| Orquestração / tools | `packages/company/src/tools/{master-tools,master-filter,pipeline-tools,review-subordinate,board-tools}.ts` |
| Tiers de company | `packages/code-agent/src/tools/tiers-company.ts` |
| Supervisor / reconciler | `packages/company/src/services/supervisor/` · `RuntimeReconciler.ts` |
| Capability / scheduler do App | `packages/company/src/tools/app-studio/` · `packages/company/src/services/scheduler/AppStudioScheduler.ts` |
| Resolver autoritativo de papéis | `packages/company/src/services/subordinate/role-runtime.ts` |
| Adoção e fachada do App | `packages/api-handlers/src/app-studio/app-team-session.ts` · `apps/http-api/server/routes/app-studio/` |
| Regras operacionais | `packages/company/src/services/master/config-loader.ts` |
| Migrations | `packages/store/src/migrations/018_company_agents.ts` (+ 034/036/038/040/065/067/085/235) |
| Rotas HTTP | `apps/http-api/server/routes/company/` |

---
---

# Part 2 — English

## Table of contents

1. [Overview](#1-overview)
2. [Concepts](#2-concepts)
3. [Prerequisites](#3-prerequisites)
4. [Step by step](#4-step-by-step)
5. [Features (panels)](#5-features-panels)
6. [How it works under the hood](#6-how-it-works-under-the-hood)
7. [Data model](#7-data-model)
8. [Environment variables](#8-environment-variables)
9. [Troubleshooting](#9-troubleshooting)
10. [Glossary and file map](#10-glossary-and-file-map)

---

## 1. Overview

In the traditional chat, **one** agent talks to you and works on **one** project. In Company Mode
you assemble a **team**:

- The **Master** is the orchestrator. It reads the board, **spawns subordinates**, approves plans,
  answers questions and reviews deliverables. It **does not read or edit code directly** — it delegates.
- The **subordinates** are the executors. Each one gets a task, works in its own isolated context,
  posts to the board and moves Kanban cards.
- Everything runs inside a **Company Session**, which links **one or more projects**, a set of
  **operational rules** and (optionally) a containerized **sandbox** for live preview.

**When to use it.** Large or multi-project tasks with parallel phases (implement + review + QA +
document), or when you want different models for different roles (e.g. an expensive model for the
Master to reason, a cheap one for mechanical work). For a one-off edit to a single file, the single
chat is still simpler.

---

## 2. Concepts

| Concept | What it is | Where it lives |
|---|---|---|
| **Template** | A **reusable** blueprint of roles (Master + subordinates). Defines who exists and the provider/model/tier each runs on. Not tied to any session. | **Templates** tab · `company_templates` table |
| **Company / Session** | A **work instance**: links projects, operational rules, model pool and (optional) sandbox. This is where agents run. | **New Company** button · `company_sessions` table |
| **Projects** | The codebases the team works on. A session links 1+ projects. | **Projects** section · `company_session_projects` table |
| **Roles** | The team's "positions". Exactly **one** `master` role is required; the rest are subordinates. | template `roles_json` / session `config_json` |
| **Operational rules** | Free-text (markdown) policy injected **verbatim** into the Master's and **every** subordinate's prompt. | **Operational rules** field |
| **Runtime / capability** | Selects which product hosts the Company lifecycle. `company` uses board/Kanban/pipelines; `app_studio` uses the App workflow and tools. | `company_sessions.runtime_kind` |

### Roles: Master vs Subordinate

| | Master | Subordinate |
|---|---|---|
| Function | Orchestrates, approves, reviews | Executes concrete tasks |
| Typical tier | `full` | `bootstrap` or `navigate` |
| Reads/edits code? | **No** (delegates) | Yes |
| Shared env | **Read-only** (`env_read`/`env_list`/`env_validate`) | Read **and** write |
| Spawns subordinates? | Yes | No |

**Role tiers** (`bootstrap | navigate | full`) control how many navigation/editing tools the role
gets. `bootstrap` = minimal (quick, well-scoped tasks); `navigate` = intermediate; `full` = the
complete set. Generic Company keeps its existing Master profile; an App-owned Master resolves to
`navigate` and is additionally constrained by the Master tool allowlist.

### Builder is now a project feature

Company sessions always work on the files of the linked projects (requires **≥1 project**).
The old company-session "Builder mode" was **retired** — the V0 experience (live preview +
element selection) became a **project** feature: create a project via the
**New Project → Builder mode** wizard and use normal chat sessions over it. Containerized
microservices (Add Service) remain available in any company session.

### App Studio: a persistent team hosted by Company

Each App owns **one specialized Company session** (`runtime_kind = 'app_studio'`) and **one active
Master**. App Studio remains responsible for creation, revisions, workflow, approvals, and
artifacts; the Company runtime provides persistent per-agent sessions, history, inbox,
pause/resume/abort, reconnection, and supervision. The team also appears in **Agents** with an
**App** badge and a link back to its workflow.

The server resolves the capability from `runtime_kind`:

- `company` keeps the generic scheduler, Kanban, and pipelines, and **does not** register `app_*`
  tools;
- `app_studio` uses the App prompt, allowlists, autonomy policy, and work source; it does not start
  the Company scheduler or use Kanban/pipelines as a second queue;
- the **App workflow is the only card source**. `/api/app-studio` remains the facade and delegates
  agent lifecycle operations to Company.

The App transport uses `/api/app-studio/sessions/:appId/team/*` for `start`, `resume`, `message`,
`answer`, `plan-response`, `abort`, `attach`, and replay. The server resolves the App → Company link
and never trusts a team id supplied by the client. Chat and Agents share one SSE connection and
real run/status/inbox events invalidate the App overview. In Agents, App teams are read-only
projections that link back to the App workflow. The projection keeps only the Board and team state;
terminal, Env, operational Inbox, databases, catalog, and mutable artifact surfaces are hidden.
Incompatible Company mutations return `APP_STUDIO_CONTROL_PLANE_OWNED`.

The editable preset starts with Master `app_orchestrator` and specialists `research`, `architect`,
`backend`, `frontend`, `database`, `ux`, `qa`, and `fullstack`. Legacy name compatibility maps
`plan → architect`, `implement/implementer → fullstack`, and `verify/verifier → qa`. The Master
coordinates, decides, and delegates; it **does not edit code**. Specialists get code tools plus
only the role-scoped `app_*` tools required to read context and record evidence.

#### Authoritative per-role runtime

For every configured-role spawn, `role_assignments` is authoritative for provider, model, tier,
reasoning, temperature, skills, prompt, fallbacks, and the thinking/budget defaults. A run may
enable thinking for that turn, but cannot replace the role runtime. In App teams, a missing,
disabled, or incompletely configured role blocks the card with a configuration error. The global
`subagent_model` override and dispatch parameters **cannot** replace that role's model, and there
is no silent fallback to the Master, the global pool, or a mini model. Fallback occurs only when
explicitly listed in the role's `fallbackModels`.

The Master exposes the same editable contract through `master_*` fields (enabled, provider/model,
tier, reasoning, temperature, thinking/budget, skills, prompt, and explicit fallback). Its
effective tier remains `navigate`, and the Master allowlist still removes code-edit tools. On a
transient failure, `master_fallback_*` updates the coder session and the same
`company_agent_run` provenance before resuming the transcript; it never consults the global
override or invents another fallback chain. Master edits never mutate a live runner: on the next
wake, the lifecycle cold-resumes the same transcript, re-resolves the full runtime, and applies the
new prompt and skills before the first turn.

Each `company_agent_run` persists configured and effective provider/model, dispatch source, and
fallback reason. Editing a role does not mutate an active run; the next card uses the new config.
A `waiting` session is reused only when role, project, and the complete configuration hash still
match.

#### Dispatch, evidence, and reconciliation

The App scheduler considers only `ready` cards after dependencies and approvals are satisfied. It
builds the first conflict-free `file_scope` wave, respects concurrency, and creates an idempotent
attempt before marking the card `running`. Multiple historical attempts are allowed, but only one
attempt may be active per card and per agent.

- valid evidence through `app_record_work_evidence` completes the attempt and preserves normal
  workflow progression into review/done;
- completion without evidence, failure, interruption, or abort blocks the card and wakes the
  Master to recover or reassign it;
- **Pause** preserves the card and session; **Resume** reuses that same session;
  **Cancel/Abort** deterministically updates the attempt, agent, and card;
- after a server restart, reconciliation compares active attempts with `company_agent_runs` and
  repairs divergent states. Automatic dispatch remains limited to ready, approved work.

#### Existing-App adoption and compatibility

Adoption is idempotent and waits for the legacy coordinator to stop running. It then creates/links
the Company session, adopts the coordinator's transcript and model as Master, and converts saved
profiles into `role_assignments`. Old sub-runs remain separately visible as **legacy runs**; they do
not become fake persistent agents. During the compatibility window, `agent_config_json`,
`coordinator_session_id`, `coder_session_id`, and old endpoints remain readable, but an adopted App
immediately stops dispatching through `execute_tasks`; solo chats remain unchanged.

"New conversation" rotates the Master only while it is idle. The previous transcript becomes
read-only and specialists remain in the same team. Deleting the App removes its linked team in the
same operation; the Company route rejects direct deletion of a session owned by an App.

---

## 3. Prerequisites

1. **Providers and models configured** in **Admin → AI** (you need at least one provider with a
   valid key; the Master and each role pick from those models).
2. **Registered/indexed projects**. Without projects the picker shows
   *"No indexed projects found."*
3. **Podman or Docker** installed and reachable **only if** you use
   containerized microservices. The default flow needs no container.
4. *(Optional)* **Skills** enabled in **Admin → Skills** — roles can enable specific skills
   (e.g. `qa-playwright`).

---

## 4. Step by step

### 4.1 Open Company Mode

Open the **"Company Agents Mode"** tab. On first run, the landing screen shows the
**"Create Your First Company"** button. Afterwards use **"New Company"** (by the Sessions list).

The sidebar has two tabs: **Sessions** (running instances) and **Templates** (reusable blueprints).

### 4.2 (Optional) Create a Template

A Template saves you from reconfiguring roles every time. **Templates tab → "New Template"**:

1. **Name** (e.g. *Web Team*) and **Description** (e.g. *Full-stack web development team*).
2. **Roles** — comes with a **`master`** role (crown icon 👑, **required** and not removable).
   Click **"Add Role"** for each subordinate.
3. Per role, click **Edit** to open the role editor:
   - **Role name** (lowercased with `_`, e.g. `code_reviewer`).
   - **Provider** + **Model**.
   - **Fallback** provider/model (auto-recovery if the primary fails).
   - **Tier**: Bootstrap / Navigate / Full.
   - **Temperature** (0–1; empty = agent preset default).
   - **Extended thinking** + token budget — only providers that support it (Anthropic, Gemini);
     costs more tokens.
   - **Skills** — grouped by source (user / builtin / plugin namespace).
   - **Available MCP packs** (read-only, non-master) — subordinates unlock on demand via `expand_toolset`.
   - **System prompt override** (markdown; supports variables like `${PROJECT_NAME}`, `${SESSION_ID}`,
     `${USER_INPUT}`, `${OS}`, `${TIMESTAMP}`).
4. **Save**. (Persists via `POST /api/company/templates`.)

> Rule: at least one role must be named **"master"** — the editor warns *"At least one role must be
> named 'master'."* if it's missing.

### 4.3 Create the Company (Session)

Click **"New Company"** to open the **"Start Company Session"** dialog:

| Field | Required | Note |
|---|---|---|
| **Session Name** | Yes | e.g. *Feature Sprint Q2* |
| **Template (optional)** | No | Pick a template, or **"Custom (no template)"**. With a template, the Master's and each role's provider/model are **locked** by the template. |
| **Projects** | Yes | Checkbox list. |
| **Master Provider/Model** | Yes | Disabled if a template is selected (the template wins). |
| **Master fallback** | No | Backup provider/model. |
| **Allowed models pool** | No | Curated list of `(provider, model)` the Master may spawn with. **Empty = no restriction.** Non-empty = the server **rejects** any spawn outside the pool. |
| **Master observes peer-to-peer** | No | Every message between subordinates yields a *notify* copy for the Master (shows up as `[INBOX-OBSERVED]`). |
| **Operational rules** | No | Markdown injected verbatim into every agent (see §6). |

Click **"Create & Start"** (`POST /api/company/sessions`). The session appears in the list and
opens; the Master comes up **on standby**, ready for your first instruction — send it in the composer (see §4.6).

### 4.4 Link and manage Projects

- **At creation**: check the projects in the checkbox list.
- **Afterwards**: in the agents sidebar, **Projects** section. Linking/unlinking is dynamic.
  - **Real** projects: unlinking **preserves files** on disk.
  - **Virtual** projects (`_builder_*`, created by containerized services): they are **torn down** fully
    (the service is removed and the project row deleted).

### 4.5 Adjust roles after creation

In the agents sidebar:

- **Configured Roles** + **"Add Role"** — creates a new role just for this session.
- **Per-role model editor** — swaps a role's provider/model.
- **Agents per project** — binds roles to specific projects; a role bound to a single project
  auto-resolves `project_id` at spawn.
- **Operational rules** — editable here. New agents pick them up **immediately**; the running
  Master on its next *reestablish*.

### 4.6 Start working

Use the composer (**"Send a message to Master..."**) to describe the goal. The Master decides the
plan, spawns subordinates, and you follow everything through the panels. When the Master submits a
**plan** or asks a **question**, a block appears for you to **Approve/Answer**.

---

## 5. Features (panels)

The session uses a **3-zone layout** (which **replace** the central area) + a side **drawer** of
"peek" panels (panels you want **alongside** the central content).

### **Work** zone (the team's day-to-day)

The tabs below describe `runtime_kind = 'company'` sessions. In `app_studio` teams, **Kanban** and
**Pipelines** are hidden: the panel links to the authoritative App workflow instead of duplicating
cards between products. Board, transcript, and real-agent controls remain available.

| Tab | What it does |
|---|---|
| **Board** | Shared feed where agents post. Message kinds: *message, decision, question, deliverable, handoff, blocker*. You can copy the board/message as Markdown. |
| **Kanban** | Columns **Backlog · To-Do · In Progress · Review · Done**. Cards with objectives, dependencies, comments and agent history. |
| **Pipelines** | Multi-stage workflows (see below). |
| **Transcript** | Historical log of inter-agent messages. |

**Pipelines** in detail: a visual builder with stage **templates** (Investigate, Gather context,
Implement, Refactor, Validate output, QA gate, Human review, Summarize, Changelog, Checkpoint,
Classify). Each node is an **Agent** or a **Validator** (decision-only:
`submit_verdict({pass|fail|review})`). Edges with **linear / pass-fail / by-tag / by-text-match**
modes. Per-node options: **Max attempts**, **model override** (run validators on a cheaper model),
and **Manual approval** (`requires_confirmation` — pauses for you to approve before advancing).
Scope: **session** (multi-project) or **global**.

### **Build** zone (artifacts the team produces)

**Docs** · **Tests** (real-time QA Playwright) · **Files** · **Git** (with **Push**) · **API** ·
**Terminal** (in the **Sandbox** or the **Host**) · **Runners**.

### **Data** zone (session persistence)

**Drive** (session files; attach folders) · **Snapshots** (code reviews with findings) ·
**Archived** (reset snapshots) · **Indexed** (per-project indexed-file table) · **Vectors**
(hybrid · vector · FTS search with inline diagnostics).

### Side drawer

| Panel | What it does |
|---|---|
| **Preview** | Dev server output (HMR) of containerized services. |
| **Inbox** | Inter-agent message queue (statuses: *pending, delivered, answered, cancelled, expired*). You can **cancel** a stuck message or **"Respond as human"** in place of the recipient. |
| **Env** | Session-wide shared environment variables (see below). |
| **Databases** | Read-only view of the linked projects' Databases-tab connections (migration 174). Agents reach them via `db_list`/`db_schema`/`db_query`/`db_command`; registration/editing happens on the project, not the session. |
| **Supervisor** | Agent health and incidents (see §6). |

**Env** in detail: variables injected as container env **and** written to `/app/.env` in every
microservice. Live edits sync to running containers. Vars are grouped by source:
**User-defined**, **Set by agent**, **Imported from .env** and **Auto** (sandbox/DB-managed — edits
may be overwritten). Secrets can be masked. The **Master is read-only** on env; subordinates read and write.

### Agents sidebar

Shows **Projects**, **Configured Roles**, **Operational rules** and the live **agent panes**, with
statuses (**Idle, Running, Working, Waiting, Plan Review, Question, Tasks Review, Reviewing,
Blocked, Done, Error, Aborted, Paused**) and per-subordinate controls (**Pause / Resume / Delete agent**).

### Session metrics

The metrics modal shows: **message** counts (Conversation / All / User-only), **durable
summarizations** (automatic and manual), a **TOKENS** block (input/output/cache/thinking + hit
ratio) and **Real Savings** (cache savings, output *shaping* and tool *tiering*).

### Self-review

- **`self_review`** — the agent runs the `snapshot_review` pipeline over its own diffs; the nudge is
  controlled by `CODER_SELF_REVIEW`.
- **`review_subordinate_work`** (Master only) — reviews a subordinate's snapshots and returns
  *findings* by severity. Findings also appear in the **Snapshots** panel. To fix, the Master uses
  **`forward_to_agent`** to send the task back to the subordinate.

---

## 6. How it works under the hood

### Master ↔ Subordinate orchestration

**Master tools** (prefixes confirmed in `master-filter.ts`): `spawn_subordinate_agent`,
`wait_for_subordinates`, `list_subordinates`, `resume_subordinate`, `abort_subordinate_agent`,
`approve_subordinate_plan`, `answer_subordinate_question`, `approve_subordinate_tasks`,
`forward_to_agent`, `finalize_subordinates`, `list_company_projects`, `post_to_board`, `read_board`,
`set_agent_status`, `kanban_*`, `review_subordinate_work`. The Master does **not** get `read_file`,
`grep_code`, `write_file`, etc. — only overview tools (`get_project_pulse`, `get_architecture`,
`list_directory`, `search`, `glob`) and communication.

**`spawn_subordinate_agent`** — main parameters: `role`, `task`, `project_id`,
`provider`/`model`/`tier`, `skills`, `wait` (block until done) and `thinking`. It is **async** by
default (`wait=false`): the subordinate runs in the background. When the role exists in
`role_assignments`, its persisted runtime is authoritative; dispatch-time provider/model/tier
overrides are ignored.

**Subordinate tools** (cannot spawn others): `ask_master`, `submit_plan_to_master` /
`submit_specification_to_master`, `submit_tasks_to_master`, `send_to_agent`, `send_to_master`,
`read_my_inbox`, `check_inbox_answer`.

### Company worker

Each session runs in a dedicated **`worker_thread`**. On boot it opens SQLite in WAL mode and
**re-wires** the module-global stores via `db.raw()` (design system, QA, env) — needed because
main-process singletons are `null` in the worker. It then instantiates the orchestrator, starts the
**AgentSupervisor**, mirrors the `metaBus` and exposes RPC to the main process.

At boot, `runtime_kind` selects the server capability. `company` sessions start the
`CompanyScheduler`; `app_studio` sessions start only the `AppStudioScheduler`, linked through
`app_studio_sessions.company_session_id`. Both share the persistent Master/subordinate lifecycle,
but they do not share a work queue.

### AgentSupervisor (anti-hang)

Enabled by **`MCP_SUPERVISOR_ENABLED=1`**. It does heartbeat tracking, detects stuck agents,
dispatches recovery and has **three circuit breakers**:

| Breaker | Trigger (default) | Effect |
|---|---|---|
| Per-agent | 3 failed recoveries in 10 min | Agent quarantined |
| Per-role | 3 failures of the same role in 10 min | Role quarantined for 5 min (no new spawns) |
| Global | 20 incidents in 1 min | **Read-only** mode for 1 min (records only, no recovery) |

The **`RuntimeReconciler`** (a **45s** sweep, `MCP_COMPANY_RECONCILE_MS`) reconciles the DB
`status` with the real runtime state and **re-nudges** the Master when a decision stalls (a **30s**
cadence, `MCP_COMPANY_MASTER_NUDGE_MS`, `0` disables).

### Wait/wake loop

The Master "sleeps" in `wait_for_subordinates` and wakes on **`MasterAttention.signal`** (kinds:
*question, plan, tasks, finished, inbox_answered, user_message, notify*). The loop combines
**level** triggering (checks pending work before sleeping) and **edge** triggering (the event), with
a 2s *safety poll* so it never misses a signal. Subordinates waiting on the Master have a **30-min**
fallback (`MCP_SUBORDINATE_MASTER_WAIT_MS`).

### Operational rules

They are injected **verbatim** into the Master's and **every** subordinate's system prompt, on
**each** start/spawn/resume. They are read **fresh** from `config_json` (never cached) and have a
**16,000-character cap** (beyond that, truncated with a notice). Living in the system prompt, they
survive reactivations and compactions.

### Tool tiers

- **`COMPANY_TOOLS`** — registered in **every** company session: shared drive
  (`read/write/append/delete/list_shared_file`), comms (`send_message`, `list_agents`,
  `wait_agents`, inbox), and env (`env_list/read/set/delete/validate` — Master read-only).
- **`BUILDER_TOOLS`** — only when a sandbox binding is present (service-bound subordinate): `db_*`, `docs_*`,
  sandbox/pipeline/service control.
- **`APP_TOOLS`** — registered only when `runtime_kind = 'app_studio'` and filtered by audience
  (Master or specialist role). Generic Company sessions never receive `app_*`, and an external tool
  cannot impersonate a native App capability.

### Model pool and concurrency

- The **allowed models pool** is validated at spawn — a `(provider, model)` outside it is rejected.
- One runtime resolver serves specialist dispatches from the Master, manual path, scheduler,
  pipeline, fan-out, retry, and App. For a configured role, the pool only validates the persisted
  choice; it never replaces it. In App teams, fallback comes exclusively from the role's explicit
  list. The Master uses the session's own persisted runtime.
- **Concurrency**: at most **10** concurrent subordinates (`CODER_COMPANY_MAX_SUBORDINATES`); when
  exceeded, the spawn asks the Master to call `wait_for_subordinates`.
- Automatic subordinate **retries**: **1** (`CODER_SUBORDINATE_MAX_RETRIES`).

---

## 7. Data model

Core tables (migration `018_company_agents.ts`):

| Table | Key columns |
|---|---|
| `company_templates` | `id`, `name`, `description`, `roles_json`, `created_at`, `updated_at` |
| `company_sessions` | `id`, `template_id` → templates, `runtime_kind` *(`company`/`app_studio`)*, `name`, `status` *(idle/running/paused/completed/error)*, `master_session_id` → `coder_sessions`, `config_json` (default `{}`), timestamps |
| `company_session_projects` | PK (`company_session_id`, `project_id`), `label` *(null = real project; set = virtual `_builder_*` service — prefix inherited from legacy sessions)* |
| `company_agent_runs` | `id`, `company_session_id`, `role`, `coder_session_id`, `project_ids_json`, configured `provider/model`, effective `provider/model`, `dispatch_source`, `fallback_reason`, `status`, timestamps |
| `company_board` | `id`, `company_session_id`, `author_role`, `agent_run_id`, `kind` (default `message`), `content`, `mentions_json`, `created_at` |

**`config_json`** (on `company_sessions`) carries: `role_assignments[]`, `allowed_models[]`,
`operational_rules` (string) and `master_broadcast_subscribe` (bool). (Legacy sessions may carry
a `builder` key from the retired mode — ignored by the current runtime.)

Additional tables in later migrations: `034` sandbox, `035` services, `036` env vars
(`company_session_envs`), `038` archives (`company_archives`), `065` fronts, `067` sub-sessions,
`085` pipeline foundation. (Migration `040`'s `company_session_databases` table was retired in
`191` — connections are per-project now, migration `174`.)

Migration `235_app_studio_company_runtime.ts` adds the App integration:

| Table/column | Purpose |
|---|---|
| `app_studio_sessions.company_session_id` | 1:1 link to a Company session with `runtime_kind = 'app_studio'` |
| `app_studio_work_item_runs` | card/attempt/role history linked to `company_agent_run`, coder session, status, configuration hash, and idempotency key |

Partial indexes enforce one active attempt per card and one active card per `company_agent_run`.
Triggers verify that the selected agent belongs to the linked team and role. App deletion removes
its links before deleting the Company session; `ON DELETE RESTRICT` prevents out-of-band team
deletion while the App still owns it.

**HTTP routes** (under `apps/http-api/server/routes/company/`): `GET/POST /api/company/templates`,
`PATCH/DELETE /api/company/templates/:id`, `GET/POST /api/company/sessions`,
`.../sessions/:id/projects`, plus `board`, `kanban`, `pipelines`, `envs`, `databases`, `drive`, `sandbox`.
Routes under `/api/app-studio/sessions/:id/agents` and `/workflow` are the App facade for role
configuration, sessions/transcripts, dispatch, and lifecycle. Responses expose
`company_session_id`, Master/team state, configured and effective provider/model, and separate
legacy runs.
The real lifecycle/stream is available exclusively through
`/api/app-studio/sessions/:id/team/{state,state-snapshot,attach,start,resume,message,answer,plan-response,wake-master,abort}`.
The server resolves and validates the App ↔ Company link before delegating; `attach`, `start`, and
`resume` preserve the Company runtime's multiplexed stream, `Last-Event-ID`, replay, and
idempotency. The App UI does not call `/api/company` directly. App-team `agent_status` events also
carry configured/effective provider and model, dispatch source, and fallback reason.

---

## 8. Environment variables

> Defaults verified in code. Everything is optional — the defaults already give the current behavior.

| Variable | Default | Effect |
|---|---|---|
| `CODER_COMPANY_MAX_SUBORDINATES` | `10` | Max concurrent subordinates (legacy fallback: `COMPANY_MAX_CONCURRENT_SUBORDINATES`). |
| `CODER_SUBORDINATE_MAX_RETRIES` | `1` | Automatic retries for a failing subordinate. |
| `MCP_SUBORDINATE_MASTER_WAIT_MS` | `1800000` (30 min) | Subordinate's fallback wait for the Master's decision. |
| `MCP_SUPERVISOR_ENABLED` | *off* | `1` turns on the AgentSupervisor (anti-hang). |
| `MCP_SUPERVISOR_PERSISTENCE` | *on* | `0` disables SQLite persistence of incidents. |
| `MCP_SUPERVISOR_AGENT_BREAKER_LIMIT` / `_WINDOW_MS` | `3` / `600000` | Per-agent breaker. |
| `MCP_SUPERVISOR_ROLE_BREAKER_LIMIT` / `_WINDOW_MS` | `3` / `600000` | Per-role breaker. |
| `MCP_SUPERVISOR_ROLE_QUARANTINE_MS` | `300000` (5 min) | Role quarantine. |
| `MCP_SUPERVISOR_GLOBAL_BREAKER_LIMIT` / `_WINDOW_MS` | `20` / `60000` | Global breaker. |
| `MCP_SUPERVISOR_GLOBAL_READ_ONLY_MS` | `60000` (1 min) | Read-only mode duration. |
| `MCP_COMPANY_RECONCILE_MS` | `45000` | `RuntimeReconciler` sweep cadence (min 1s). |
| `MCP_APP_STUDIO_SCHEDULER_TICK_MS` | `10000` | Specialized App scheduler cadence (min 2s; `runtime_kind = 'app_studio'` only). |
| `MCP_COMPANY_MASTER_NUDGE_MS` | `30000` | Re-nudge a stalled Master; `0` disables. |
| `MCP_COMPANY_INBOX_WATCHDOG_ENABLED` | *off* | `1` turns on the inbox watchdog. |
| `MCP_COMPANY_INBOX_MAX_PENDING` | `3` | Max pending messages per recipient. |
| `MCP_COMPANY_INBOX_STALE_IDLE_MS` | `300000` (5 min) | Idle threshold for marking the inbox "stale". |
| `MCP_COMPANY_INBOX_WAIT_TIMEOUT_MS` | `1200000` (20 min) | Wait timeout for an inbox message. |
| `CODER_SELF_REVIEW` | *off* | Enables/disables the opt-in self-review nudge. |

### 8.1 Autonomy flags (C2 — the organism ships ON by default)

> Precedence: **session** (`config_json.autonomy.*`, Autonomy panel / PATCH `/config`) >
> **env** > **default**. Session `autonomy.freeze: true` live-kills EVERY autonomous action
> (checked at each tick/use — no worker restart needed).

| Variable | Default | Effect |
|---|---|---|
| `MCP_COMPANY_SCHEDULER` | *on* | Kill-switch for the autonomous scheduler AND the orphaned-card reset: `0` disables (`1` still enables — back-compat no-op). Per session: `autonomy.scheduler` / `autonomy.orphanReset`. |
| `MCP_COMPANY_AUTO_APPROVE_ROLES` | `*` (every role) | When PRESENT it overrides the default: csv = allowlist, `*` = all, explicit empty string = nobody self-approves. Per session: `autonomy.autoApproveRoles` (list, `'*'` or `null`). |
| `MCP_SUPERVISOR_MASTER` | *on* | Kill-switch for the Master supervisor: `0` disables. Safe by default — the long waits heartbeat (`agent-wait-loop`/`await-master`). Per session: `autonomy.supervisorMaster`. |
| `MCP_COMPANY_GLOBAL_MAX_SUBORDINATES` | `8` | GLOBAL subordinate budget (cross-session count): int>0 = cap, `0` = uncapped, absent/invalid = 8. Per session: `autonomy.maxSubordinates` (int>0; `null` = back to default policy — NOT "no limit"). |

---

## 9. Troubleshooting

- **Session stalled / "Session stalled"** — the *"X min without progress"* banner appears when the
  Master may be blocked on a tool or waiting on a human. Click **Continue**. For automatic detection
  and recovery, enable **`MCP_SUPERVISOR_ENABLED=1`**.
- **Master won't wake** — use **"Wake now"** in the standby banner. If decisions keep stalling,
  confirm `MCP_COMPANY_MASTER_NUDGE_MS` isn't `0`.
- **Spawn rejected** — common causes: (a) **concurrency cap** (10) — the Master must call
  `wait_for_subordinates`; (b) **outside the pool** — *"Model 'x/y' is not in this session's allowed
  pool"*; (c) **role quarantined** by a supervisor breaker.
- **App card blocked before spawn** — verify that the role exists, is enabled, and has an explicit
  provider/model. The App runtime blocks invalid configuration instead of inheriting
  `subagent_model`, the Master's model, or a mini model.
- **App specialist finished but the card was blocked** — the run ended without accepted evidence.
  Open the specialist transcript, fix the cause, and resume/reassign; the specialist must call
  `app_record_work_evidence` before completing.
- **App shows "migration pending"** — the legacy coordinator or current Master is still running.
  Wait until it becomes idle and reload; adoption is idempotent and never runs two teams in parallel.
- **Env var doesn't appear / env tool fails** — usually a store not wired in the worker; the
  company-worker boot re-wires via `db.raw()`. Check the **Env** tab and the var's source.
- **Master ended with error / ended unexpectedly** — the banners ask you to **send a message to
  resume**; the session reopens from where it stopped.

---

## 10. Glossary and file map

**Glossary.** *Master* = orchestrator agent. *Subordinate* = executor agent. *Template* = role
blueprint. *Session/Company* = work instance. *Tier* = a role's tool level. *Operational rules* =
policy injected into all agents. *Board* = the team
feed. *Model pool* = the allowed list of provider/model.

**File map (for devs).**

| Area | Path |
|---|---|
| Create company (UI) | `apps/dashboard/features/agents/NewCompanyDialog.tsx` (+ `new-company-dialog/`) |
| Create template (UI) | `apps/dashboard/features/agents/{TemplateBuilderModal,RoleEditModal,TemplateListPanel}.tsx` |
| Sidebar / roles / rules | `apps/dashboard/features/agents/session-view/`, `OperationalRulesEditor.tsx` |
| Zones and tabs | `apps/dashboard/features/agents/zones/` · `preview-sidebar/` |
| Contracts | `packages/company-contracts/src/models/{template,pipeline}.ts` |
| Orchestration / tools | `packages/company/src/tools/{master-tools,master-filter,pipeline-tools,review-subordinate,board-tools}.ts` |
| Company tiers | `packages/code-agent/src/tools/tiers-company.ts` |
| Supervisor / reconciler | `packages/company/src/services/supervisor/` · `RuntimeReconciler.ts` |
| App capability / scheduler | `packages/company/src/tools/app-studio/` · `packages/company/src/services/scheduler/AppStudioScheduler.ts` |
| Authoritative role resolver | `packages/company/src/services/subordinate/role-runtime.ts` |
| App adoption and facade | `packages/api-handlers/src/app-studio/app-team-session.ts` · `apps/http-api/server/routes/app-studio/` |
| Operational rules | `packages/company/src/services/master/config-loader.ts` |
| Migrations | `packages/store/src/migrations/018_company_agents.ts` (+ 034/036/038/040/065/067/085/235) |
| HTTP routes | `apps/http-api/server/routes/company/` |

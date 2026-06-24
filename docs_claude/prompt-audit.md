# Claude Code — Auditoria dos Prompts e Validação dos MDs

> Auditoria complementar solicitada para revalidar os documentos em `docs/` contra
> extrações do binário `claude.exe` (Claude Code v2.1.181, Bun standalone).
>
> Fontes usadas nesta rodada:
> - `_cc_prompts.txt` — prompts/strings `You are ...`, `IMPORTANT`, `CRITICAL`.
> - `_tool_mining_report.md` — janelas de contexto por tool/padrão.
> - `_tool_logic_scan.md` — contexto por nome de tool.
> - `_tool_name_report.json` — nomes/aliases e offsets observados.
> - `_tools_*.txt` — ranges extraídos do binário para inspeção local.
>
> **Status:** os documentos anteriores estavam majoritariamente corretos em alto
> nível, mas alguns pontos precisavam de ressalva: contagens fechadas, listas de
> tipos de agente, comandos/tokens avançados e áreas onde o texto transformava
> prompt literal em arquitetura inferida.

---

## 1. Resultado executivo

| Documento | Resultado | Correção/complemento necessário |
|---|---|---|
| `docs/agents.md` | Parcialmente validado | Marcar seleção de identidade, output styles e tipos de subagente como observados/inferidos quando não há trecho de dispatch completo. |
| `docs/tools.md` | Validado, mas incompleto | Expandir lógica interna em `docs/tool-logic.md`; corrigir contagem `~35`; adicionar `PowerShell`, `MultiEdit`, `ScheduleWakeup`, ressalvas de aliases. |
| `docs/commands.md` | Parcialmente validado | Separar comandos confirmados de tokens/config strings observados; marcar recursos avançados como não necessariamente slash commands expostos. |
| `docs/memory-system.md` | Bem validado | Adicionar detalhes de granularidade/frontmatter e seletor conservador de memória se ainda ausentes. |
| `docs/session-flow.md` | Bem validado | Manter prompts literal de coordinator/worker; marcar topologia/diagramas como interpretação arquitetural derivada dos prompts. |

---

## 2. Auditoria por documento

### 2.1 `docs/agents.md`

#### Confirmado

- As três identidades textuais existem como prompts/strings:
  - `You are Claude Code, Anthropic's official CLI for Claude.`
  - `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
  - `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
- Existem prompts especializados além das identidades principais:
  - coordinator;
  - worker fork;
  - file search specialist;
  - software architect/planning specialist;
  - guide agent;
  - security/code review;
  - memory extraction/dream;
  - verification executor.

#### Ressalvas/correções

- A frase “três variantes selecionadas conforme contexto de execução” deve ser lida
  como **inferência forte**, não como dispatch table recuperada por completo. As
  strings existem; a seleção runtime completa não foi reconstruída integralmente.
- Output styles (`proactive`, `explanatory`, `learning`) aparecem como prompts/templates,
  mas a seção `Learning` pode ser mais um template operacional do que um “modo” fechado.
- Tipos de subagente (`fork`, `explore`, `implement`, `full`, `persistent`) devem ser
  documentados como **observados nesta build**, não como enumeração estável/fechada
  para todas as versões.
- “Modo autônomo” aparece como conjunto de guardrails/prompt + feature gates; quando
  descrito como “modo runtime”, convém separar o que é prompt/guardrail do que é UI.

---

### 2.2 `docs/tools.md`

#### Confirmado

- `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Skill`,
  `EnterPlanMode`, `AskUserQuestion`, `StructuredOutput`, `CronCreate` e várias
  ferramentas de team/MCP aparecem nas extrações.
- `Read`/`Write`/`Glob` têm guardrails recuperados com alta confiança.
- `StructuredOutput` tem lógica clara: AJV, validação por JSON Schema, erro de mismatch
  e retorno estruturado.
- `PowerShell` existe como tool/nome interno separado de `Bash`.

#### Correções/complementos

- A contagem `~35 tools` era conservadora e incompleta. A extração encontrou **40+**
  nomes/aliases, mas com disponibilidade dependente do runtime.
- `ListPeers` não foi confirmado com o mesmo nível de `ListAgents`; deve ficar como
  possível alias/conceito ou baixa confiança.
- `MultiEdit` aparece como nome esperado/observado, mas sem descrição completa nos
  trechos legíveis; deve ficar com ressalva.
- Adicionar/remeter para `docs/tool-logic.md`, que contém a lógica por tool e níveis
  de confiança.

---

### 2.3 `docs/commands.md`

#### Confirmado

- Comandos básicos como `/help`, `/clear`, `/compact`, `/memory`, `/memories`,
  `/resume`, `/release-notes`, `/add-dir`, `/terminal-setup`, `/vim`, `/rename`
  são coerentes com as strings observadas.
- Há strings/tokens para provider setup, reload, usage/cost, doctor/status/export/init/review.

#### Ressalvas/correções

- A seção “Subcomandos e Configurações” mistura comandos reais, subcomandos e tokens
  de configuração. Deve dizer explicitamente que são **tokens observados no binário**,
  não garantia de slash command exposto em todo modo.
- Recursos avançados (`radio`, `simulate-usage`, `rewind`, `scroll-speed`, etc.) devem
  ser marcados como tokens/feature strings observados.
- `autoCompactWindow (100000–1000000 chars)` é plausível como schema/setting observado,
  mas deve ser apresentado como valor observado nesta build, não contrato público.

---

### 2.4 `docs/memory-system.md`

#### Confirmado

- Arquitetura de alto nível está correta:
  - `CLAUDE.md` / instructions;
  - Agent Memory persistente baseada em arquivos;
  - estado efêmero de sessão.
- Diretriz de memória granular é confirmada:
  - uma memória por arquivo;
  - checar duplicatas antes de criar;
  - deletar memórias obsoletas/contraditas.
- Existem prompts de:
  - memory extraction subagent;
  - memory selector conservador;
  - dream/pruning;
  - dream/reflective pass.

#### Complementos recomendados

- Explicitamente mencionar frontmatter observado nas memórias (`name`, `description`,
  `type`) quando aplicável.
- Reforçar que o seletor de memória é conservador e retorna até 5 arquivos úteis.
- Reforçar que “dream” não edita memória in-place: combina deletando arquivos antigos
  e criando um novo single-fact file quando necessário.

---

### 2.5 `docs/session-flow.md`

#### Confirmado

- Prompt de coordinator está fortemente validado:
  - ajuda usuário;
  - direciona workers;
  - sintetiza resultados;
  - não delega quando pode responder sem tools;
  - worker results/system notifications são sinais internos.
- Prompt de worker fork está fortemente validado:
  - transcript herdado é referência, não continuidade;
  - executa uma diretiva;
  - não spawna subagentes;
  - reporta uma vez e para.
- Prompt de team/teammate está validado:
  - usa team config e task list;
  - envia updates para `team-lead`;
  - usa nomes de teammates em `SendMessage`.

#### Ressalvas/correções

- Diagramas de “Main Thread Agent”, “Peer”, “topologia” são interpretação arquitetural
  derivada dos prompts, não necessariamente nomes oficiais internos.
- Cross-session `uds:`/`bridge:` aparece em prompt de coordinator, mas convém manter
  a distinção: peers não são workers e não devem receber delegação sem confirmação.
- O documento deve separar visualmente “prompt literal” vs “interpretação”.

---

## 3. Prompts adicionais revalidados

A lista `You are ...` contém cerca de 40 prompts distintos, incluindo:

- `You are a coordinator...`
- `You are a worker fork...`
- `You are a teammate in this session's agent team.`
- `You are a file search specialist...`
- `You are a software architect and planning specialist...`
- `You are a senior security engineer...`
- `You are a verification executor...`
- `You are the Claude guide agent...`
- `You are now acting as the memory extraction subagent...`
- `You are selecting memories that will be useful...`
- `You are performing a dream — a pruning pass...`
- `You are performing a dream — a reflective pass...`
- `You are orchestrating a large, parallelizable change...`
- `You are running in non-interactive mode...`

A documentação atual cobre a maior parte desses prompts em `docs/agents.md`,
`docs/memory-system.md` e `docs/session-flow.md`; os novos ajustes são principalmente
de **precisão epistemológica**: dizer o que foi extraído literalmente, o que foi
inferido, e o que é runtime-dependent.

---

## 4. Correções aplicadas nesta rodada

- Criado `docs/tool-logic.md` com lógica interna por tool, confiança e lacunas.
- Este arquivo (`docs/prompt-audit.md`) registra a auditoria e ressalvas por documento.
- `docs/tools.md` deve apontar para `docs/tool-logic.md` e substituir contagem rígida
  por inventário runtime-dependent.
- `docs/commands.md`, `docs/agents.md` e `docs/session-flow.md` devem receber notas
  de validação/ressalva nas seções onde havia inferência arquitetural.

---

## 5. Limites conhecidos da auditoria

- O bytecode JavaScriptCore não foi decompilado integralmente; várias funções aparecem
  minificadas/corrompidas em janelas de strings.
- Nem todos os schemas de tool foram recuperados.
- Feature flags (`tengu_*`) indicam que comportamento pode variar por build/conta/ambiente.
- Nem todo token observado é slash command público.
- Nem todo nome observado é tool exposta ao modelo em todas as sessões.

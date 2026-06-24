# Claude Code — Slash Commands

> Documentação extraída via engenharia reversa do binário `claude.exe`
> (Claude Code v2.1.181, Bun standalone).
>
> Revalidação: veja `docs/prompt-audit.md`. Tokens encontrados no binário nem sempre
> são slash commands públicos em todos os modos; este arquivo separa comandos
> confirmados de tokens/config strings observados.

---

## Visão Geral

Slash commands são atalhos digitados pelo usuário no REPL do Claude Code
(formato `/<comando>`). Alguns são built-in (embutidos no binário), outros são
customizáveis via Skills. Abaixo, os comandos confirmados com base nas strings
embutidas.

Constraints de uso:
- *"Do not use for built-in CLI commands"* (referência a `/help, /clear, etc.`)
- Skills customizadas são invocadas como `/<skill-name>`

---

## Comandos Built-in Confirmados

### /help
> Lista comandos disponíveis e ajuda de uso.

### /clear
> Limpa o contexto da conversa atual (reinicia o histórico visível).

### /compact
> Compacta o contexto — resume e descarta histórico antigo para liberar tokens.
> Setting: `autoCompactWindow` (100000–1000000 chars).

### /memory
> Abre/edita o arquivo de memória (CLAUDE.md / memórias persistentes).

### /memories
> Lista memórias salvas.
> Endpoint relacionado: `/memories/export` — exporta todas as memórias.

### /resume
> Retoma uma sessão anterior.
> Mensagens: *"/resume: loading sessions..."*

### /release-notes
> Mostra notas de versão do Claude Code.

### /add-dir
> Adiciona diretório ao contexto/working set da sessão.

### /terminal-setup
> Configura integração com terminal (keybindings, shell integration).

### /vim
> Entra em modo de edição vim (configurável via `/config → Editor mode`).

### /rename
> Renomeia a sessão/tópico.
> Setting: `terminalTitleFromRename` — *"Whether /rename updates the terminal tab
> title (defaults to true)."*

---

## Subcomandos e Configurações

Encontrados como tokens de configuração/subcomando no binário (UTF-16LE table).
**Ressalva:** a presença do token não prova, sozinha, que ele seja um slash command
público exposto em todo modo/runtime:

| Token | Função |
|---|---|
| `config` | Abre configurações |
| `model` | Seleciona modelo (Opus/Sonnet/Haiku) |
| `action` | Ação administrativa |
| `info` | Mostra informações do ambiente |
| `agent` | Configura agente |
| `doctor` | Diagnóstico de instalação |
| `status` | Status da sessão/conexão |
| `export` | Exporta conversa |
| `init` | Inicializa projeto (`CLAUDE.md`, settings) |
| `review` | Modo de revisão de código |
| `login` / `logout` | Autenticação |
| `mcp` | Gerencia servidores MCP |
| `cost` | Mostra uso/custos da sessão |

### Cloud / Provider setup
| Token | Função |
|---|---|
| `setup-bedrock` | Configura AWS Bedrock como provider |
| `setup-vertex` | Configura Google Vertex AI como provider |
| `install-github-app` | Instala GitHub App integration |
| `install-slack-app` | Instala Slack App integration |

### Features avançadas / tokens observados

Estes itens devem ser lidos como **feature strings/tokens observados**, não como
garantia de comando público estável.

| Token | Função |
|---|---|
| `extra-usage` | Solicita uso extra (além do limite) |
| `fast` | Liga fast mode (`fastMode` setting) |
| `passes` | Créditos/passes de uso |
| `powerup` | Ativa power-ups |
| `radio` | Modo radio (?) |
| `remote-env` | Configura ambiente remoto |
| `scroll-speed` | Ajusta velocidade de scroll |
| `toggle-memory` | Liga/desliga sistema de memória |
| `usage` | Mostra uso de tokens/créditos |
| `perf-issue` | Reporta problema de performance |
| `reload-plugins` | Recarrega plugins |
| `reload-skills` | Recarrega skills |
| `reset-limits` | Reseta limites de uso |
| `simulate-usage` | Simula uso (testing) |
| `rewind` | Retrocede na conversa |

---

## Configurações Relevantes (settings)

Extraídas do schema de configuração (Zod) no binário:

| Setting | Tipo | Descrição |
|---|---|---|
| `outputStyle` | string | Estilo de output (`proactive`/`explanatory`/`learning`) |
| `viewMode` | enum | `default`/`verbose`/`focus` — modo de visualização do transcript |
| `language` | string | Idioma preferido para respostas e dictation |
| `effortLevel` | enum | `low`/`medium`/`high`/`xhigh` — nível de esforço do modelo |
| `fastMode` | boolean | Liga fast mode |
| `ultracode` | boolean | xhigh effort + workflow orchestration dinâmico |
| `autoCompactWindow` | number | Tamanho da janela de auto-compactação (100K–1M) |
| `alwaysThinkingEnabled` | boolean | Habilita thinking automático |
| `syntaxHighlightingDisabled` | boolean | Desabilita syntax highlight em diffs |
| `spinnerTipsEnabled` | boolean | Mostra dicas no spinner |
| `spinnerVerbs` | object | Customiza verbos do spinner (`append`/`replace`) |
| `terminalTitleFromRename` | boolean | `/rename` atualiza título da aba |
| `skipWebFetchPreflight` | boolean | Pula blocklist check do WebFetch |
| `feedbackSurveyRate` | number 0-1 | Probabilidade da pesquisa de qualidade |
| `advisorModel` | string | Modelo para o advisor tool server-side |
| `forceLoginMethod` | enum | `claudeai`/`console`/`gateway` |
| `sandbox` | object | Configuração de sandbox |

---

## Login Methods

| Método | Quando usar |
|---|---|
| `claudeai` | Claude Pro/Max subscription |
| `console` | Anthropic Console billing (API credits) |
| `gateway` | Cloud gateway OIDC device flow |

---

## Flags de Ambiente

Variáveis de ambiente reconhecidas pelo binário:

| Env Var | Função |
|---|---|
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | Diretório base para memória remota |
| `CLAUDE_UPDATER_TOKEN` | Token JWT para auto-update override |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Guidelines extra para memória em cowork |
| `_BUN_WATCHER_CHILD` | (interno) processo watcher filho do Bun |

---

## Skills como Comandos

Skills customizadas são invocadas como slash commands:

```
/<skill-name>
```

Regras:
- A skill deve aparecer na lista de skills disponíveis OU o usuário deve digitar
  explicitamente `/<name>`.
- O agente nunca deve inventar nomes de skills.

---

## Notas

- A lista completa de slash commands não é um array estático no binário — muitos
  são registrados dinamicamente via plugins/skills em runtime.
- Os comandos acima foram confirmados via strings literais embutidas.
- Settings em UTF-16LE podem conter comandos adicionais não capturados aqui.

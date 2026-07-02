# UI, CLI, TUI e App Surfaces

## Visão geral

Codex possui múltiplas superfícies de UX:

- wrapper npm/Node `@openai/codex`;
- binário Rust `codex`;
- TUI interativa;
- modo não interativo `codex exec`;
- review não interativo;
- app-server JSON-RPC para IDE/desktop/clientes ricos;
- MCP server;
- SDKs.

O README público apresenta essa separação: IDE integration, desktop app via `codex app`, e Codex Web em ChatGPT (`.referece/codex/README.md:6-8`). A instalação cobre curl|sh, PowerShell, npm global e Homebrew cask, finalizando com `codex` (`.referece/codex/README.md:16-40`).

## Wrapper npm/Node

`codex-cli/bin/codex.js` é o entrypoint npm. Ele escolhe o binário nativo por OS/arch, encaminha args, configura env vars de instalação gerenciada e repassa sinais/exit code (`.referece/codex/codex-cli/bin/codex.js:1-205`).

O wrapper mapeia plataforma para pacotes opcionais e exibe dica de install/update quando pacote nativo falta (`.referece/codex/codex-cli/bin/codex.js:15-22`, `.referece/codex/codex-cli/bin/codex.js:73-104`). Ele detecta se a instalação é gerenciada por Bun ou npm e define `CODEX_MANAGED_BY_BUN`, `CODEX_MANAGED_BY_NPM` e `CODEX_MANAGED_PACKAGE_ROOT` (`.referece/codex/codex-cli/bin/codex.js:119-148`).

## CLI Rust

A CLI principal é definida por `MultitoolCli`: sem subcomando, opções vão para a TUI interativa (`.referece/codex/codex-rs/cli/src/main.rs:91-120`). A lista de subcomandos mostra que a CLI é a surface agregadora de runtime, auth, app-server, MCP, sandbox, sessões, update e cloud (`.referece/codex/codex-rs/cli/src/main.rs:123-212`).

Debug inclui um subcomando para renderizar o input model-visible como JSON, útil para auditar prompt/contexto (`.referece/codex/codex-rs/cli/src/main.rs:221-245`).

## TUI: entrypoint e flags

O binário TUI Rust parseia args, mescla config overrides, roda `run_main` e imprime mensagens de saída como hints de resume/session ID (`.referece/codex/codex-rs/tui/src/main.rs:41-83`).

Flags públicas incluem (`.referece/codex/codex-rs/tui/src/cli.rs:8-76`):

- prompt posicional;
- `--strict-config`;
- `--ask-for-approval/-a`;
- `--search`;
- `--no-alt-screen`;
- controles internos de resume/fork;
- opções compartilhadas de CLI.

`dangerously_bypass_approvals_and_sandbox` conflita com `approval_policy` (`.referece/codex/codex-rs/tui/src/cli.rs:135-139`).

## TUI: terminal lifecycle

A inicialização do terminal habilita bracketed paste, raw mode, keyboard enhancement e focus-change reporting (`.referece/codex/codex-rs/tui/src/tui.rs:175-190`). Restore tem caminhos separados: restore completo, manter raw e cleanup específico de saída (`.referece/codex/codex-rs/tui/src/tui.rs:280-317`). A TUI exige stdin e stdout terminais e limpa input buffered (`.referece/codex/codex-rs/tui/src/tui.rs:375-385`).

## ChatWidget

`ChatWidget` é a raiz de composição da UI. O construtor conecta `BottomPane`, transcript state, session header, status/state caches, model/provider state, collaboration state, plugins, IDE context, notifications, goals, editor state e overlays/popups (`.referece/codex/codex-rs/tui/src/chatwidget/constructor.rs:5-286`).

O bottom pane é instanciado com foco, enhanced-key support, placeholder, paste-burst behavior, animações e skill metadata (`.referece/codex/codex-rs/tui/src/chatwidget/constructor.rs:98-107`). O construtor sincroniza key bindings, vim mode, status line, collaboration modes, command enablement, mentions, token activity command, Windows sandbox status e connectors (`.referece/codex/codex-rs/tui/src/chatwidget/constructor.rs:246-282`).

Renderização principal é uma composição flex de transcript ativo, hook cell, token activity/rate-limit opcionais e reserva do bottom pane (`.referece/codex/codex-rs/tui/src/chatwidget/rendering.rs:5-60`). Renderização reserva espaço para pet/ambient image e mantém scroll de history cells (`.referece/codex/codex-rs/tui/src/chatwidget/rendering.rs:63-117`).

## Input routing

Roteamento global de teclas prioriza superfícies ativas no bottom pane. Caso contrário, ChatWidget lida com Ctrl+C, Ctrl+D, image paste, edição de mensagem em fila, dismissal de plan-mode, popups de plugin e cycling de collaboration mode (`.referece/codex/codex-rs/tui/src/chatwidget/interaction.rs:6-185`).

Paste de imagem só anexa imagem local se o modelo atual suporta imagens; caso contrário emite warning no histórico (`.referece/codex/codex-rs/tui/src/chatwidget/interaction.rs:187-202`). Paste textual é delegado ao bottom pane e pode disparar redraw quando paste burst flushes (`.referece/codex/codex-rs/tui/src/chatwidget/interaction.rs:341-349`).

## Bottom pane

O bottom pane é documentado como footer interativo que possui o composer e views transitórias; sua entrada é roteada por camadas e possui quit hint temporizado (`.referece/codex/codex-rs/tui/src/bottom_pane/mod.rs:1-16`). Estado inclui composer, stack de popups/modais, approvals pendentes, task-running state, status widgets, pending input preview, thread approvals, key bindings e métricas de context window (`.referece/codex/codex-rs/tui/src/bottom_pane/mod.rs:203-243`).

`BottomPane::new` configura foco do composer, keymap default, skill mentions e estado inicial de footer/status (`.referece/codex/codex-rs/tui/src/bottom_pane/mod.rs:245-300`). Widgets transitórios incluem command popup, file search popup, skills toggle, selection tabs, list selection, review popups, permission popups, model popups, plugin catalog, hooks browser e memories settings.

## IDE context

A TUI possui módulo para suporte `/ide`. O schema inclui `activeFile` com selection ranges e `openTabs` com labels/paths; campos extras são ignorados na desserialização (`.referece/codex/codex-rs/tui/src/ide_context.rs:1-52`). Testes demonstram payload aceito de IDE com seleção ativa, conteúdo selecionado e tabs abertas (`.referece/codex/codex-rs/tui/src/ide_context.rs:60-115`).

## Slash commands e docs

A documentação local de slash commands aponta para docs externas (`.referece/codex/docs/slash_commands.md:1-4`). Isso sugere que a lista e UX final de slash commands é mantida fora do repo open-source, embora a TUI implemente popups e comandos internamente.

## App-server como UI protocol

`codex app-server` é a interface usada para experiências ricas como extensão VS Code (`.referece/codex/codex-rs/app-server/README.md:1-3`). Ele usa JSON-RPC 2.0 similar a MCP e suporta stdio, websocket experimental, unix socket e off (`.referece/codex/codex-rs/app-server/README.md:20-29`). O server expõe health probes no modo websocket e rejeita requests com Origin header (`.referece/codex/codex-rs/app-server/README.md:31-37`).

Clientes devem inicializar conexão com `initialize` e `initialized`; o server retorna user agent, `codexHome`, plataforma e recusa requests antes da inicialização (`.referece/codex/codex-rs/app-server/README.md:83-100`). O `clientInfo.name` é usado para compliance logs (`.referece/codex/codex-rs/app-server/README.md:96-100`).

## API de UI rica

O app-server expõe endpoints para:

- thread lifecycle: start/resume/fork/list/read/archive/delete/unsubscribe/name;
- turn lifecycle: start/steer/interrupt;
- realtime: start/appendAudio/appendText/appendSpeech/stop;
- review: `review/start`;
- command exec e process spawn;
- filesystem: read/write/create/metadata/list/remove/copy/watch;
- model list e capabilities;
- permission profiles;
- environments;
- collaboration modes;
- skills/hooks/plugins/apps;
- MCP OAuth/status/resource/tool call;
- Windows sandbox setup;
- feedback;
- config read/write/batchWrite/requirements.

Esses endpoints aparecem na visão geral da API (`.referece/codex/codex-rs/app-server/README.md:138-247`). Em particular, `turn/start` inicia geração e streama `turn/started`, `item/*` e `turn/completed`; `turn/steer` adiciona input a turno em andamento; `turn/interrupt` cancela turno (`.referece/codex/codex-rs/app-server/README.md:171-180`).

## Logging e diagnóstico

Docs de install citam logs/diagnostics da TUI: diagnósticos locais por default, `log_dir` habilita logs plaintext, e `codex exec` usa `RUST_LOG=error` por padrão (`.referece/codex/docs/install.md:52-65`).

## Pontos notáveis

- A TUI é rica e composta em camadas, não apenas um REPL simples.
- O app-server é a principal surface para IDEs/desktop e equivale a um protocolo de UI remoto.
- O bottom pane centraliza input, modais, approvals, comandos e status.
- Há suporte explícito a IDE context, modelos multimodais e session management.

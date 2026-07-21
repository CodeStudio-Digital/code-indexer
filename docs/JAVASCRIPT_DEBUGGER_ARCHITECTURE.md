# Plataforma de Debug e plugin JavaScript

Status: implementação inicial em andamento  
Escopo inicial: JavaScript e TypeScript  
Protocolo: Debug Adapter Protocol (DAP)

## Objetivo

Adicionar ao MCP uma experiência de depuração integrada, semelhante à oferecida
por IDEs como o WebStorm:

- breakpoints no gutter do editor;
- execução da configuração selecionada em modo Run ou Debug;
- pause, continue, step-over, step-in e step-out;
- call stack, scopes, variáveis, watches e avaliação de expressões;
- source maps para TypeScript e bundlers;
- sessões Node.js, processos filhos e Electron;
- ciclo de vida persistente no host, independente da navegação do renderer.

O primeiro plugin será `javascript-debugger`. A plataforma deve permanecer
agnóstica de linguagem para permitir futuros plugins de Python, PHP, Java,
C#/.NET e outras linguagens sem reconstruir a interface.

## Referência arquitetural do WebStorm

A análise do plugin decompilado `javascript-debugger` do WebStorm mostrou os
seguintes padrões que serão aproveitados como referência comportamental e
arquitetural, sem copiar código proprietário:

| WebStorm | Plataforma MCP |
| --- | --- |
| `JavaScriptDebugEngine` | contribuição `debuggers` + runtime `debuggerRuntime` |
| `NodeDebugProgramRunner` | resolução estruturada de configuração Run/Debug |
| `NodeDebugPortsHandler` | orquestração de sessões filhas e múltiplos targets |
| `WipBreakpointManager` | store de breakpoints + sincronização DAP |
| `WipSuspendContext` | snapshot da sessão pausada e motivo da pausa |
| `WipCallFrame` | frames, scopes, variáveis e evaluate |
| scripts/VMs virtuais | fontes DAP virtuais somente leitura |
| source-map subsystem | mapeamento para fontes TypeScript/originais |
| Debug Window | aba Debug host-native no painel inferior |

Decisões preservadas da experiência JetBrains:

1. Breakpoints pertencem ao projeto/editor, não ao processo em execução.
2. Run e Debug partem da mesma configuração selecionada.
3. O runtime pode mover ou rejeitar um breakpoint; a UI deve refletir isso.
4. Processos filhos são sessões/targets ligados à sessão principal.
5. Frames e referências de variáveis expiram quando a execução continua.
6. Source maps e fontes geradas são parte do núcleo do debugger.
7. Stop, restart, erro e shutdown devem limpar todos os recursos.

## Por que DAP

O Debug Adapter Protocol separa a interface genérica do IDE do debugger de
cada linguagem. O MCP implementa uma vez o editor e o painel de debug; cada
plugin fornece um adaptador e resolve suas configurações específicas.

Para JavaScript será usado o servidor DAP standalone do `vscode-js-debug`,
distribuído sob licença MIT. O artefato oficial será:

- versão: `1.117.0`;
- arquivo: `js-debug-dap-v1.117.0.tar.gz`;
- SHA-256: `ad8d04ede9d4b75cc290fd5438a65047a06f786d04f604b6112485b36f090772`;
- origem: release oficial `microsoft/vscode-js-debug` no GitHub.

O build baixa o artefato em cache, verifica o hash antes de extrair e inclui
somente o diretório necessário no bundle first-party. O repositório não deve
versionar o binário gerado.

## Arquitetura

```text
Monaco + ProjectIdeToolbar + DebugTab
                  |
               DebugApi
                  |
          DebugSessionManager
            |             |
       DAP connection   PtyManager
            |             |
     vscode-js-debug   terminal integrado
            |
   Node / npm / Electron / navegador
```

### Responsabilidade do host

- protocolo DAP, correlação de requests, timeouts e eventos;
- estado e ciclo de vida das sessões;
- persistência e sincronização de breakpoints;
- execução de adaptadores first-party;
- atendimento de reverse requests como `runInTerminal`;
- abertura segura de fontes locais e virtuais;
- editor, toolbar, painel Debug, atalhos e terminal;
- encerramento de processos e recuperação após navegação do renderer.

### Responsabilidade do plugin JavaScript

- declarar linguagens, extensões e managers compatíveis;
- detectar projetos Node, TypeScript e Electron;
- localizar o adaptador empacotado;
- resolver configurações DAP `launch` e `attach`;
- transformar scripts npm/pnpm/yarn/bun em configurações estruturadas;
- definir defaults de source maps, async stacks, child processes e skip files;
- evoluir posteriormente para browser e sessões Electron compostas.

### Limite de confiança

O runtime executável de debugger será aceito inicialmente apenas quando:

- o plugin foi instalado com `source: bundled`;
- o namespace é first-party;
- o manifest usa o protocolo conhecido `debug-adapter-v1`;
- o adaptador solicitado foi declarado no snapshot validado.

Plugins de Market podem declarar metadados no futuro, mas não poderão executar
um adaptador até existir uma permissão assinada específica.

## Contrato de contribuição

Manifest declarativo:

```ts
debuggers: [{
  id: 'javascript',
  label: 'JavaScript / TypeScript',
  languageIds: ['javascript', 'typescript'],
  filePatterns: ['*.js', '*.mjs', '*.cjs', '*.ts', '*.mts', '*.cts'],
  runnerManagers: ['node', 'npm', 'pnpm', 'yarn', 'bun'],
  activation: {
    whenFiles: ['package.json', 'tsconfig.json'],
  },
  supports: {
    launch: true,
    attach: true,
    conditionalBreakpoints: true,
    hitConditionalBreakpoints: true,
    logpoints: true,
  },
}]
```

Runtime first-party:

```ts
export const debugAdapter = defineDebugAdapter({
  id: 'javascript',
  resolveAdapter,
  resolveConfiguration,
})
```

O CLI registra a exportação em `.app.json`:

```json
{
  "debuggerRuntime": {
    "protocol": "debug-adapter-v1",
    "entry": "./dist/plugin.js",
    "adapters": ["javascript"]
  }
}
```

## Modelo de sessão

```text
starting -> initializing -> configuring -> running
                                            |
                                            v
                                         paused
                                            |
                                            v
                                         running
                                            |
                                            v
terminating --------------------------> terminated
       \---------------------------------> error
```

Uma sessão contém:

- `sessionId`, `adapterId`, projeto, nome e configuração;
- estado e timestamps;
- processo do adaptador e processo/terminal do debuggee;
- capabilities negociadas no `initialize`;
- threads e frame atualmente selecionado;
- motivo da pausa;
- output limitado;
- sessões filhas/targets;
- epoch que invalida referências antigas após resume/restart.

## Handshake DAP

1. Resolver o runtime first-party pelo `adapterId`.
2. Iniciar o servidor DAP em loopback e porta dinâmica.
3. Conectar e enviar `initialize`.
4. Enviar `launch` ou `attach`.
5. Esperar o evento `initialized`.
6. Enviar todos os breakpoints por fonte e exception filters.
7. Enviar `configurationDone`.
8. Processar `stopped`, `continued`, `output`, `breakpoint`, `thread`,
   `terminated` e `exited`.
9. Em stop/shutdown, enviar `disconnect`/`terminate` e encerrar a árvore de
   processos mesmo se o adaptador não responder.

## Integração com Runners

O runner deve evoluir de uma string de shell para uma invocação estruturada:

```ts
interface RunnerInvocation {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  target?: RuntimeTarget
}
```

O campo legado `command` permanece para compatibilidade e apresentação. Run e
Debug consomem a mesma invocação; o plugin decide como convertê-la em uma
configuração DAP.

Primeiras resoluções JavaScript:

- arquivo JS/TS: `pwa-node`, `program`, argumentos e cwd;
- script npm/pnpm/yarn/bun: `runtimeExecutable` + `runtimeArgs`;
- Electron: primeiro o main process, depois sessão composta main/renderer;
- attach: processo/inspector escolhido explicitamente pelo usuário.

## Breakpoints no Monaco

Estados visuais:

- vermelho sólido: verificado;
- círculo vazio: pendente/não verificado;
- apagado: desabilitado;
- losango: logpoint;
- seta + destaque de linha: frame atual.

Interações:

- clique: adicionar/remover;
- `Ctrl+F8`: adicionar/remover;
- menu de contexto: condição, hit condition, log message e enable/disable;
- atualização do model: usar tracked ranges e debounce;
- rename/delete: acompanhar eventos do workspace.

Os lanes do glyph margin já são usados por run, plugins e símbolos. Será criado
um coordenador de gutter com prioridade:

1. breakpoint/frame atual;
2. Run/Debug;
3. ação de plugin;
4. navegação de símbolo.

Colisões na mesma linha devem abrir um seletor, nunca registrar listeners que
compitam pelo mesmo clique.

## Painel Debug

A aba host-native no painel inferior conterá:

- sessões e threads;
- call stack;
- scopes e variáveis carregados sob demanda;
- watches;
- Debug Console/evaluate;
- breakpoints e exception filters;
- controles de execução.

O terminal existente continuará exibindo stdout/stderr. Uma fonte DAP com
`sourceReference` abre em model virtual somente leitura; caminhos físicos são
normalizados e confinados ao projeto antes de abrir no editor.

## Segurança

- bind apenas em `127.0.0.1`;
- porta dinâmica, nunca exposta ao renderer;
- limite de tamanho para frame DAP e output;
- timeout e cancelamento de requests;
- allowlist de reverse requests;
- validação de cwd, arquivos, argumentos e ambiente;
- redaction de environment e mensagens sensíveis;
- evaluate somente por ação explícita;
- attach remoto desabilitado no MVP;
- cleanup idempotente de sockets, listeners, terminais e árvores de processo;
- hash e versão fixa do adaptador empacotado.

## Fases

### Fase 1 — Fundação executável

- schemas e tipos `debuggers`/`debuggerRuntime`;
- helper `defineDebugAdapter`;
- plugin `extensions/javascript-debugger`;
- download/staging verificado do `vscode-js-debug`;
- loader first-party;
- parser/framing DAP e gerenciamento básico de processo/conexão;
- testes de manifest, resolver e protocolo.

### Fase 2 — Sessões e API

- `DebugApi` e `DebugSessionManager`;
- launch/attach/stop/restart;
- pause/continue/steps;
- eventos e snapshots reconectáveis;
- `runInTerminal` via `PtyManager`;
- configuração estruturada dos runners.

### Fase 3 — Editor e toolbar

- breakpoint store e migration;
- coordenador de gutter;
- `Shift+F9`, `Ctrl+F8` e atalhos de stepping;
- botões Play/Debug/Stop;
- reveal da linha pausada.

### Fase 4 — Painel Debug

- threads/call stack;
- scopes/variables;
- watches/evaluate;
- exception breakpoints;
- fontes virtuais.

### Fase 5 — JavaScript avançado

- TypeScript/source maps;
- child processes/workers;
- Electron main + renderer;
- Chrome/Vite/Next;
- auto attach e debug terminal;
- WSL/path mapping;
- sessões compostas.

### Fase 6 — Novas linguagens

Somente depois de estabilizar o plugin JavaScript:

- Python com `debugpy`;
- C#/.NET com adapter DAP compatível;
- PHP com Xdebug e path mappings;
- Java com Java Debug Server/JDT e resolução de classpath.

Nenhum desses plugins faz parte da implementação inicial.

## Testes

### Unitários

- framing parcial e múltiplas mensagens no mesmo chunk;
- request/response, timeout e desconexão;
- validação de manifests e confiança first-party;
- resolução de arquivo, package script e Electron;
- hash e extração segura do artefato;
- path confinement;
- state machine e cleanup idempotente;
- sincronização completa de breakpoints por fonte.

### Integração com adapter falso

Fluxo obrigatório:

```text
initialize -> initialized -> setBreakpoints -> configurationDone
-> stopped -> stackTrace -> scopes -> variables
-> next/continue -> terminated
```

Também testar `runInTerminal`, `startDebugging`, timeout e encerramento abrupto.

### E2E JavaScript

1. Abrir fixture Node.
2. Criar breakpoint antes de iniciar.
3. Pressionar `Shift+F9`.
4. Parar na linha exata.
5. Inspecionar variável e avaliar expressão.
6. Executar step-over e continue.
7. Ver stdout no terminal.
8. Reiniciar preservando o breakpoint.
9. Navegar e voltar preservando a sessão.
10. Encerrar sem processo órfão.

Fixtures adicionais:

- TypeScript com source map;
- processo filho Node;
- Electron main process;
- breakpoint movido/não verificado;
- múltiplas sessões.

## Critérios de aceite do MVP

- plugin JavaScript validado, empacotado e sem binário não verificado;
- execução de arquivo Node e script package manager em modo Debug;
- breakpoint persistente e verificado no editor;
- pause/continue/step-in/step-out/step-over;
- call stack, scopes, variables e evaluate;
- source maps TypeScript;
- terminal integrado;
- sessão sobrevive à navegação do renderer;
- restart e stop limpam todos os processos;
- Run existente continua sem regressão;
- nenhum plugin de outra linguagem é introduzido nesta etapa.

## Arquivos e áreas previstas

- `packages/plugin-sdk/src/contributions/types.ts`
- `packages/plugin-sdk/src/manifest/app-json.schema.ts`
- `packages/plugin-sdk/src/debug-adapter.ts`
- `packages/plugin-sdk/src/cli/build.ts`
- `packages/plugin-host/src/debugger-loader.ts`
- `packages/api-bus/src/debug.ts`
- `packages/api-handlers/src/debug/`
- `packages/api-handlers/src/terminal/pty-manager.ts`
- `packages/api-bus/src/runner.ts`
- `extensions/javascript-debugger/`
- `scripts/build-bundled-plugins.mjs`
- `apps/dashboard/features/project/ProjectIdeToolbar.tsx`
- `apps/dashboard/features/workspace/editor/MonacoMount.tsx`
- `apps/dashboard/features/workspace/BottomPanel.tsx`
- próxima migration disponível para breakpoints persistidos.

## Não objetivos da primeira entrega

- copiar código decompilado da JetBrains;
- criar um debugger CDP/WIP próprio;
- plugins PHP, Java, Python ou C#;
- attach em hosts públicos;
- profiler, coverage, heap snapshots ou DOM inspector;
- permitir executáveis de debugger vindos de plugins não confiáveis.

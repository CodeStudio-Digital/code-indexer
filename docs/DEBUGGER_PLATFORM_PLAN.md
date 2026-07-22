# Plataforma de depuração do MCP CodeStudio

## Objetivo

Criar uma plataforma de debug extensível, com breakpoints no editor, execução
de runners em modo debug e uma UI única para JavaScript/TypeScript e futuros
adapters de PHP, Java, Python e C#.

O primeiro plugin implementado é `javascript-debugger`, usando o protocolo DAP
e o adapter `js-debug` empacotado como dependência first-party.

## Princípios adotados do WebStorm

- O IDE é dono da sessão e do ciclo de vida dos processos; o plugin descreve a
  configuração, mas não recebe permissão genérica para criar processos.
- Porta de debug é alocada dinamicamente em loopback, reservada até o instante
  em que o runtime pode ocupá-la.
- Processo do runner e conexão de debug são ciclos de vida diferentes. Isso é
  essencial para Wrangler/Workerd: o host lança `wrangler dev` e o adapter faz
  apenas `attach` ao Inspector.
- Uma conexão DAP de bootstrap pode ser substituída por uma sessão filha sem
  encerrar o debug inteiro.
- Breakpoint tem dois estados: intenção persistida do usuário e estado
  transitório retornado pelo runtime (`verified`, relocado ou rejeitado).
- Encerramento sempre limpa somente a árvore de processos pertencente à sessão,
  por PID conhecido, sem comandos globais por nome.

## Arquitetura

```text
Editor/Gutter
    -> Debug API / Session Manager
        -> Plugin runtime (configuração declarativa)
        -> Host target process (opcional, PID controlado)
        -> DAP adapter process
            -> runtime Inspector / debug server
```

### Contratos

O SDK aceita dois resultados de resolução:

1. Configuração DAP direta, usada por um arquivo Node comum.
2. Configuração estruturada com `dapRequest`, `configuration` e `target`, usada
   quando o host precisa lançar o runner separadamente do attach.

Nenhum comando arbitrário é inferido pelo host. O plano de target é produzido
por plugin first-party confiável, executado com ambiente limpo e encerrado como
árvore de processo de propriedade da sessão.

## JavaScript/TypeScript — fase atual

### Entregue

- Breakpoints persistentes no gutter do Monaco.
- Breakpoint vermelho preenchido quando verificado e vazado quando provisório
  ou rejeitado, com mensagem do adapter.
- Propagação dos eventos DAP `breakpoint changed` para atualizar o gutter quando
  uma fonte carregada tardiamente passa a aceitar o breakpoint.
- Launch de arquivo Node e scripts npm/pnpm/yarn/bun.
- Porta dinâmica e reservada para Inspector.
- Wrangler detectado pelo comando real do script.
- Wrangler iniciado pelo host com `--inspector-port`; js-debug conecta com um
  `attach` normal ao Workerd.
- Wrapper temporário do entrypoint Wrangler preserva exports default/nomeados e
  cria uma pausa técnica invisível antes do primeiro handler.
- A sessão filha instala source maps e breakpoints durante essa pausa e só então
  retoma o Workerd, permitindo parar já na primeira requisição.
- Tratamento de sessões filhas de js-debug sem considerar o fechamento da
  conexão bootstrap como falha.
- Preservação da mensagem de erro real e inclusão dos diagnósticos do adapter.
- Cleanup da árvore do runner e do adapter em erro, stop e término normal.
- Smoke test real que inicia Wrangler, verifica o breakpoint TypeScript, pausa,
  avalia uma expressão, continua e valida a resposta HTTP.

### Particularidade do Workerd

O script do Worker aparece no Inspector apenas quando a primeira requisição
materializa o target. O plugin inicia essa chamada por um wrapper temporário com
uma pausa de primeira instrução, seguindo o mesmo princípio observado no
WebStorm. Essa pausa não chega à UI: o host abre a sessão DAP filha, aplica os
breakpoints da fonte TypeScript, espera a confirmação e retoma internamente.
Assim, a própria primeira requisição para no breakpoint do usuário. O wrapper é
removido ao encerrar e não altera arquivos-fonte do projeto.

## Próximas fases

### Consolidação JavaScript

- UI de call stack, scopes, variables, watches e console de debug.
- Breakpoints condicionais, hit count, logpoints e exception breakpoints.
- Attach por PID/process picker e attach remoto explicitamente configurado.
- Electron main/renderer e processos filhos com seletores de target.
- Testes de Vite, Next.js, Jest/Vitest e source maps compostos.

### Novos plugins

- PHP: Xdebug via um adapter DAP, com descoberta de porta e mapeamento de paths.
- Python: debugpy, mantendo o Python escolhido pelo projeto e attach/launch
  separados.
- Java: Java Debug Server sobre o JDT LS, com classpath vindo do projeto.
- C#: netcoredbg ou adapter compatível, integrado à descoberta do SDK .NET.

Cada linguagem reutiliza `DebugSessionManager`, transporte DAP, modelo de
breakpoints, UI e ownership de processos. Apenas detecção, preparação do
runtime e configuração do adapter pertencem ao plugin da linguagem.

## Critérios de conclusão por plugin

- Launch e attach testados em runtime real.
- Breakpoint verificado e pausa em fonte original.
- Stack, scopes, variables, evaluate, continue e stepping validados.
- Stop e falha de inicialização sem processos órfãos.
- Erro original e stdout/stderr visíveis no Output.
- Nenhum caminho ou porta fixa e nenhum kill global por nome.

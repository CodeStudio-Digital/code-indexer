# Agent Runtime Host

Infraestrutura TypeScript compartilhada para execução, política e resultados
dos agentes. A aplicação fornece o worker e os ports de persistência; este
package organiza o ciclo de vida de cada tentativa e a API usada pelas
superfícies do produto.

## Módulos

- `src/facade/`: `AgentRuntimeFacade`, handles de execução e ports do control
  plane. Inicia ou retoma execuções, encaminha cancelamentos e respostas a
  interações, consulta snapshots e acompanha eventos.
- `src/facade/LegacyAgentRuntimeAdapter.ts`: adapta o launcher e a lease do
  worker TypeScript fornecidos pelo produto. Provider, credenciais, permissões
  e eventos de transporte continuam sob responsabilidade do worker.
- `src/router/`: registra a rota de uma tentativa antes do launch e rejeita
  conflitos com uma rota já persistida. A única geração suportada é
  `legacy_ts`, com preferência `legacy_required`; os nomes são identificadores
  de compatibilidade do contrato existente.
- `src/runtime-policy/`: resolve e valida camadas de configuração, produz
  snapshots e registra a origem dos valores e o digest da política resolvida.
- `src/tool-result.ts`: contratos de resultados, erros, limites de saída e
  decisões dos guards. Exportado pelo subpath
  `@mcp/agent-runtime-host/tool-result.js`.
- `src/errors.ts`: erros tipados da fachada e do roteamento.
- `src/index.ts`: exports públicos de fachada, roteamento e política.

## Contratos de execução

A fachada valida a identidade e a validade da tentativa preparada antes de
entregá-la ao adapter. A rota é persistida de forma idempotente; uma tentativa
não pode receber outra rota depois do commit. Falhas de preparação e launch
são registradas pelos ports do control plane.

`AgentRunHandle.dispose()` libera apenas o handle local. Cancelar a execução
exige `cancel()`, que registra a solicitação antes de encaminhá-la ao adapter.
A persistência de sessões é implementada por
[`packages/session-storage`](../session-storage/src/file-session-repository.ts).

O package não contém IPC binário, Protobuf, addon, supervisor ou runner Rust.
O histórico da retirada está no
[registro de remoção](../../docs/architecture/runtime-retirement.md).

## Validação

Na raiz do repositório, execute `pnpm agent:host:test` para os testes dos
contratos e do host, e `pnpm typecheck` para conferir sua integração com os
consumidores TypeScript.

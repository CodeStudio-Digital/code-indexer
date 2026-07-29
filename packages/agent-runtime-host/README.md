# Agent Runtime Host

Fronteira neutra entre o control plane TypeScript e as gerações de runtime.
Este package não importa nem reexporta implementações do agente legado ou do
runner Rust.

## Módulos

- `facade/`: API estável consumida pelas superfícies do produto, handles leves
  e ports de persistência/execução.
- `router/`: decisão fail-closed e durável da geração usada por cada attempt.
- `ipc/`: framing e canais bounded, com ownership, replay e deadlines
  vinculados à attempt.
- `driver/`: lifecycle e o `RustHostAttemptCoordinator` single-use. Em
  `test|shadow`, ele espera a barreira durável
  `LaunchAccepted → Spawned → Containment`, liga o `ActivationAuthoritySeal`,
  abre control somente depois dos fatos e ACKs e conduz
  `AgentHello → Prepare → Prepared → durable grant → Activate → Ack → Active`.
- `adapters/`: composição interna `test|shadow` entre fatos duráveis e um owner
  de endpoint protegido. Ela liga reservation, resource group, runtime,
  provenance, endpoint, connection, deadline e peer esperado antes de entregar
  o transporte ao driver. Control e Data têm owners nominais distintos; Data
  faz bind single-use e hidrata snapshots/artifacts diretamente da fonte
  filesystem por chunks bounded antes do receipt de `Prepared`. Cleanup
  precisa retornar `closed` ou transferir ownership a um reaper nativo.
  `NativeHostAttemptBridgeRequest` produz o request Protobuf single-use
  consumido pelo core Rust e zera os bytes exatos após settlement.
- `native/`: loader do addon a partir do pacote verificado, contrato ABI
  Node-API 8 e transferência single-use do request para o owner Rust.
- `errors.ts`: erros tipados compartilhados pelas duas fronteiras.
- `index.ts`: único ponto público de composição.

`ipc/`, `driver/` e `adapters/` não são exportados pelo package root. JavaScript
somente consome owners opacos já autenticados; não transforma PID, path ou
token em prova física. O core `agent-host-bridge` cria esses owners e consulta
o peer no mesmo HANDLE/FD; `agent-host-bridge-napi` já os mantém in-process,
com I/O bounded, cancelamento compartilhado e cleanup explícito, e o loader só
aceita seu artefato hasheado. Produção ainda requer adaptar esses canais ao
framing/driver sem reopen e comprovar o E2E Prepare/Activate. Projectors,
Provider Gateway e Tool Host entram em diretórios
próprios sem mover autoridade de persistência para o runtime. O coordinator
permanece interno até existirem o E2E físico, loop multi-launch, crash recovery,
rehydration durável, reaper nativo e dispatch atômico de efeitos em produção.

## Regras

- A rota é persistida atomicamente antes de qualquer launch.
- Uma attempt nunca troca de geração após a rota ser persistida.
- `rust_required` falha fechado; não faz fallback silencioso.
- `AgentRunHandle.dispose()` libera só o handle local e não cancela o run.
- `Prepared` só nasce de receipt ligado ao inbound fisicamente committed.
- A hidratação Data é streaming e bounded; fonte, token, chunks e transport
  são single-use e falham fechados sob cancelamento, deadline ou hash
  divergente.
- Autoridade ativa só é instalada após ACK correlacionado ao
  `ActivateAttempt`, com o deadline novamente verificado.
- O `ActivationAuthoritySeal` atravessa supervisor e bootstrap; o activation
  nonce bruto permanece no Host até o `ActivateAttempt`.
- PID/UID recebido como dado JavaScript nunca autentica um endpoint. Probe,
  fechamento e reabertura do canal também não preservam identidade física.
- Arquivos produtivos devem permanecer abaixo de 250 linhas.
- Novas referências ao source tree de `packages/code-agent` são bloqueadas pelo
  gate de arquitetura do repositório.

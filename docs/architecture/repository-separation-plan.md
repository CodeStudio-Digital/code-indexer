# Plano de separação do monorepo

> Plano histórico anterior à remoção do runtime Rust. A seção de extração do runtime foi substituída pelo [registro de remoção](./runtime-retirement.md). Caminhos e contagens são os do snapshot original.

> Status: proposta revalidada contra `feature/ide-mvp` em `1a7cf741`.
> Escopo: limpeza estrutural, fronteiras de domínio e migração incremental para repositórios independentes.
> Princípio: nenhuma pasta será extraída antes de construir, testar e empacotar isoladamente no monorepo atual.

## 1. Objetivo

Separar o repositório atual em seis bounded contexts com ciclos de release independentes, contratos producer-owned e integração por artefatos versionados. O split não pode alterar comportamento do produto, perder histórico, exigir checkouts irmãos, introduzir dependências Git/submodules ou transformar pacotes internos em APIs públicas por acidente.

A topologia-alvo é:

1. `codestudio-core`;
2. `codestudio-desktop`;
3. `codestudio-cloud`;
4. `codestudio-plugin-market`;
5. `codestudio-plugin-platform`;
6. `codestudio-agent-runtime`.

Os nomes e o novo scope npm são provisórios até a ADR de distribuição. As fronteiras e a direção das dependências não são provisórias.

## 2. Evidência revalidada

### 2.1 O workspace atual não representa o produto inteiro

- O workspace pnpm inclui apenas `packages/*` e `services/*`; `apps`, `extensions` e `worker-market` ficam fora (`pnpm-workspace.yaml:1-4`).
- O TypeScript raiz compila `src`, todos os packages e apps não-React para um único `dist` (`tsconfig.json:4-7`).
- Vitest resolve os packages diretamente para `packages/*/src`, inclusive Cloud, SDKs e runtime (`vitest.config.ts:6-11`, `vitest.config.ts:29-61`).
- Os manifests internos são majoritariamente `private`, versão `0.0.0` e exportam TypeScript-fonte. `@mcp/api-handlers`, por exemplo, não declara dependências e expõe wildcard para `src` (`packages/api-handlers/package.json:1-18`).
- O auditor de dependências atual usa somente as dependências da raiz e isenta todo `@mcp/*`, portanto não comprova fechamento por package (`scripts/check-undeclared-deps.mjs:10-20`, `scripts/check-undeclared-deps.mjs:48-60`).

Conclusão: a existência de `package.json` não significa que a pasta já seja publicável ou extraível.

### 2.2 Electron, renderer e backend ainda são uma unidade de build

- O build Electron compila o TypeScript raiz, dashboard, preload, plugins e runtime Rust (`scripts/build-electron.mjs:109-160`).
- O instalador inclui Electron, HTTP API, MCP Server, dashboard, todos os packages, plugins e runtime nativo (`apps/electron/electron-builder.json:9-55`).
- O main process importa diretamente HTTP API, handlers e code-agent (`apps/electron/main.ts:32-68`).
- `BackendHandle.local` ainda expõe `ServerDeps`, Hono e handlers; esses acessos precisam virar operações do host (`apps/electron/src/backend/handle.ts:14-39`).
- O modo `utilityProcess` está reservado, mas não implementado (`apps/electron/src/backend/create.ts:12-20`).
- O release valida o fechamento real do ASAR a partir de Electron e HTTP API (`scripts/release/verify.mjs:14-16`, `scripts/release/verify.mjs:54-77`).

Conclusão: Core e Desktop são destinos diferentes, mas devem ser os últimos a se separar.

### 2.3 Cloud já possui ciclo operacional próprio, mas não contrato próprio

- Cloud API e `packages/cloud-*` já têm CI, secret scan e deploy manualmente aprovado (`.github/workflows/cloud-api-ci.yml:8-16`, `.github/workflows/cloud-api-ci.yml:32-39`, `.github/workflows/cloud-api-ci.yml:60-81`).
- O Account Portal é uma SPA autônoma e chama o Worker diretamente, sem Electron (`apps/account-portal/README.md:3-9`).
- O contrato remoto e o route map estão dentro de `@mcp/api-bus`, que também é o bus local (`packages/api-bus/src/cloud/contract.ts:1-7`, `packages/api-bus/src/cloud/route-map.ts:1-18`).
- O contrato admite que tipos de billing são sincronizados manualmente (`packages/api-bus/src/cloud/contract.ts:31-33`).
- O Portal importa tipos Cloud do bus do Core (`apps/account-portal/lib/api.ts:11`).
- O Worker possui D1, KV, R2, Durable Objects, email e recursos produtivos com IDs existentes; a extração não pode recriá-los (`services/cloud-api/wrangler.jsonc:19-48`).

Conclusão: Cloud pode sair cedo, depois que o contrato HTTP pertencer ao produtor.

### 2.4 Plugin Market tem autoridade e risco próprios

- O Market é um Worker com D1, R2, chave pública e segredo de assinatura próprios (`worker-market/wrangler.jsonc:11-30`).
- A API cobre catálogo, download, publish e moderação (`worker-market/src/index.ts:4-11`, `worker-market/src/index.ts:46-105`).
- Tipos de catálogo são duplicados no Worker e no cliente (`worker-market/src/catalog.ts:3-12`, `packages/plugin-market-client/src/index.ts:7-16`).
- O host valida assinatura sobre o hash antes da extração, mas o smoke atual testa somente a fronteira criptográfica offline, não o fluxo completo (`scripts/market-smoke.ts:2-16`).
- Não existe workflow dedicado do Market.

Conclusão: Market deve ter repositório próprio por chave, banco, moderação e ciclo de deploy, mesmo que use Cloudflare.

### 2.5 Plugin Platform ainda depende de internals do Core

- O build de bundles chama o CLI por caminho-fonte (`scripts/build-bundled-plugins.mjs:49-59`).
- `@mcp/plugin-sdk` depende de `@mcp/provider-sdk` e exporta `src` por wildcard (`packages/plugin-sdk/package.json:6-16`).
- `@mcp/provider-runtime` depende de code-agent e indexer (`packages/provider-runtime/package.json:10-14`).
- Providers first-party importam o helper do runtime do Core (`extensions/provider-chatgpt/src/plugin.ts:1-3`).
- ChatGPT e Copilot importam o registry de capacidades de code-agent (`extensions/provider-chatgpt/src/discovery.ts:1-8`, `extensions/provider-copilot/src/discovery.ts:1-6`).
- `extensions/unity-scene-analyzer` é um gitlink alterado sem `.gitmodules`; a origem precisa ser recuperada antes de substituí-lo por release.

Conclusão: as extensões só podem sair após SDK e contracts virarem folhas reais.

### 2.6 Agent Runtime já possui artifact seam, mas continua ligado à raiz

- O workspace Rust contém onze crates e toolchain próprio (`native/agent-runtime/Cargo.toml:1-29`).
- O empacotador já gera binários, manifesto, build ID e SHA-256 por target (`scripts/package-rust-agent-runtime.mjs:60-145`).
- O mesmo empacotador usa a versão do `package.json` raiz e grava a âncora no output Electron (`scripts/package-rust-agent-runtime.mjs:105-154`).
- O CI do runtime ainda observa e usa scripts, package/lock e configuração Electron (`.github/workflows/rust-agent-ci.yml:7-40`).
- `agent-runtime-host` agora depende de `provider-sdk`; seu typecheck referencia diretamente o tsconfig do SDK (`packages/agent-runtime-host/package.json:9-16`).
- Os gates formais G0-G7 ainda têm bloqueadores; a migração funcional não está concluída (`docs/architecture/rust-agent-runtime/IMPLEMENTATION-CHECKLIST.md:46-56`).
- A ADR vigente mantém o engine OSS como adapter substituível, sem autoridade sobre policy, sessão ou tools (`docs/architecture/code-run-refactor/09-oss-engine-decision.md:19-36`).

Conclusão: o runtime pode ganhar repositório antes do cutover funcional G7, mas apenas depois que package/host/contratos funcionarem sem a raiz e sem Electron.

### 2.7 Há sujeira rastreada e local que precisa ser classificada

Rastreado e regenerável:

- `*.tsbuildinfo`;
- outputs `.js`, `.d.ts` e `.map` ao lado de `provider-sdk/src/*.ts`;
- `packages/provider-sdk/dist-contract`, cujo próprio tsconfig declara `outDir` (`packages/provider-sdk/tsconfig.contract.json:3-7`);
- logs Wrangler;
- metadados locais de IDE/configuração.

Rastreado e deliberado:

- bindings Protobuf TS/Rust, porque o CI regenera e exige diff zero (`.github/workflows/rust-agent-ci.yml:84-89`);
- migrations e fixtures de protocolo/release.

Local e não classificado:

- diretórios Unity de validação e `scratch`;
- chave PEM local ignorada;
- stores/caches e instalação `node_modules` com links recursivos e paths longos.

Conclusão: limpar o índice somente após provar regeneração; não apagar trabalho local implicitamente.

## 3. Repositórios-alvo e ownership

### 3.1 `codestudio-core`

Responsabilidade: engine local/headless, persistência, APIs e ferramentas que implementam as capacidades do produto.

Conteúdo inicial:

- `apps/http-api`;
- `apps/cli`;
- `apps/mcp-server`;
- `packages/api-bus` e `packages/api-handlers`;
- `packages/code-agent`, `company`, `company-contracts`, `docs-agent` e `indexer`;
- `packages/store`, `session-storage`, `db-drivers`, `services` e `shared`;
- `packages/provider-engine`, `provider-runtime` e `plugin-host`;
- `packages/app-studio`, `design-system`, `sprite-studio`, `candidate-pipeline` e `orchestrator-host`;
- `packages/worker-pool` somente se a auditoria confirmar consumidor real; caso contrário, remover;
- Docker, evals, benchmarks e testes do backend;
- docs e scripts pertencentes ao Core.

Superfícies publicáveis:

- `@codestudio/core-host`: ciclo de vida, request/stream dispatch, métricas e shutdown;
- `@codestudio/local-api-contracts`: contrato renderer/CLI/Core;
- nenhum outro package vira público sem ADR.

O Core não conhece Electron, Cloudflare deployment, Portal ou implementação de UI.

### 3.2 `codestudio-desktop`

Responsabilidade: shell desktop, renderer, segurança do dispositivo, montagem e release do produto instalado.

Conteúdo inicial:

- `apps/electron`;
- `apps/dashboard`;
- `packages/secret-box`;
- `packages/vault-crypto`;
- assets, visual/E2E tests, installer e release desktop;
- docs e scripts do desktop.

Dependências externas permitidas:

- `@codestudio/core-host` e local API contracts;
- cloud client/contracts;
- runtime artifacts por target;
- extension-pack assinado;
- bibliotecas npm de UI/Electron.

O Desktop não importa `store`, `services`, `code-agent`, `@apps/http-api` nem paths-fonte do Core. Imports atuais do dashboard para store/services/code-agent precisam virar contratos ou utilitários explicitamente publicados antes do split.

### 3.3 `codestudio-cloud`

Responsabilidade: conta, auth, billing, feedback, sharing, sync, backup, teams, GitHub App e Portal.

Conteúdo inicial:

- `services/cloud-api`;
- `packages/cloud-kernel`, `cloud-identity`, `cloud-billing`, `cloud-sharing`, `cloud-feedback`;
- `apps/account-portal`;
- D1 migrations e configurações de Worker/Pages;
- `docs/cloud-api` e scripts cloud.

Superfície publicável:

- `@codestudio/cloud-client`, gerado ou validado a partir de schema versionado;
- DTOs, rotas e error model remotos;
- sem código de persistência, secrets ou bindings Cloudflare no cliente.

O contrato Cloud é producer-owned. Core/Desktop não espelham tipos manualmente.

### 3.4 `codestudio-plugin-market`

Responsabilidade: catálogo, moderação, storage, assinatura e distribuição de plugins.

Conteúdo inicial:

- `worker-market`;
- `packages/plugin-market-client`;
- schema/migrations D1;
- fixtures e testes de assinatura;
- CI/deploy e documentação do Market.

Superfície publicável:

- `@codestudio/market-client`;
- schema de catálogo/download/publicação;
- vetores canônicos de SHA-256/Ed25519.

A chave privada nunca entra em fixture, pacote ou repositório consumidor.

### 3.5 `codestudio-plugin-platform`

Responsabilidade: authoring SDK, provider contracts, conformance e extensões first-party.

Conteúdo inicial:

- `packages/plugin-sdk`;
- `packages/provider-sdk`;
- `packages/podman-core`;
- `extensions/*`;
- CLI de create/build/validate/publish;
- fixtures de compatibilidade e extension-pack.

Superfícies publicáveis:

- `@codestudio/plugin-sdk`;
- `@codestudio/provider-contracts`;
- CLI do SDK;
- extension-pack assinado e índice com `minHostVersion`/`maxHostVersion`.

`provider-runtime` permanece no Core. O helper puro `defineProviderAdapterFromSpec` migra ao SDK/provider contracts; wires, stores, discovery host-side e provider engine não migram.

Cloudflare manager e `provider-cloudflare` pertencem a Plugin Platform: integram o IDE a Cloudflare, mas não operam a infraestrutura do CodeStudio Cloud.

### 3.6 `codestudio-agent-runtime`

Responsabilidade: supervisor/runner/engine Rust, protocolo cross-language, host TS e artifacts nativos.

Conteúdo inicial:

- `native/agent-runtime`;
- `packages/agent-runtime-contracts`;
- `packages/agent-runtime-host`;
- scripts de package/verify/smoke/performance;
- gates, ADRs e docs do runtime.

Superfícies publicáveis:

- contratos Protobuf e bindings TS;
- host TS;
- artifact por OS/arquitetura com manifesto, versão de protocolo, ABI, checksums, provenance e SBOM.

A fonte de verdade cross-language continua sendo `.proto`; bindings gerados não são editados manualmente. O pacote não conhece Electron, ASAR, dashboard ou package version do Core.

## 4. Mapa origem → destino

| Origem atual | Destino | Ação antes da extração |
|---|---|---|
| `apps/http-api`, `apps/cli`, `apps/mcp-server` | Core | manifest por app, fechamento de deps e smoke process-real |
| `apps/electron` | Desktop | substituir imports `@apps/http-api` por `core-host` |
| `apps/dashboard` | Desktop | remover imports de store/services/code-agent internals |
| `apps/account-portal` | Cloud | consumir cloud-client producer-owned |
| `packages/cloud-*`, `services/cloud-api` | Cloud | schema/API versionado e CI isolado |
| `worker-market`, `plugin-market-client` | Market | unificar tipos e criar integração local completa |
| `plugin-sdk`, `provider-sdk`, `podman-core`, `extensions/*` | Plugin Platform | SDK leaf, manifests/builds isolados e bundles assinados |
| `provider-runtime`, `provider-engine`, `plugin-host` | Core | separar contrato authoring de implementação host-side |
| `native/agent-runtime`, `agent-runtime-contracts`, `agent-runtime-host` | Agent Runtime | package/version independentes da raiz/Electron |
| `secret-box`, `vault-crypto` | Desktop | manter APIs browser/main explícitas |
| `api-bus` | Core | separar contrato local de cloud-contracts |
| `company-contracts` | Core | continuar producer-owned pelo Core; Desktop consome somente API local publicada |
| `app-studio`, `design-system`, `sprite-studio` | Core inicialmente | separar DTOs/UI puros antes de qualquer reclassificação |
| `shared` | Core | decompor por domínio; nunca criar `shared-repo` |
| `worker-pool` | Core ou remoção | confirmar consumidores por AST/Knip e testes |
| `docker`, `evals`, `benchmarks`, `src` legado | Core por padrão | mover cada fixture/teste ao dono real |
| `.github/workflows` | todos | workflow nativo por repo; remover path filters do super-repo |
| `docs`, `scripts` | todos | classificar pelo código/serviço que documentam ou operam |
| `.idea`, settings locais, logs, tsbuildinfo, outputs de build | nenhum | remover do índice e ignorar |
| gitlink Unity | Plugin Platform | recuperar origem/licença e substituir por artifact release pinado |

## 5. Grafo de dependências permitido

```text
codestudio-plugin-platform ──publishes──> plugin/provider contracts + extension-pack
codestudio-agent-runtime  ──publishes──> runtime host/contracts + native artifacts
codestudio-cloud          ──publishes──> cloud-client
codestudio-plugin-market  ──publishes──> market-client

codestudio-core
  ├── consumes provider contracts
  ├── consumes runtime host/contracts
  └── consumes market-client

codestudio-desktop
  ├── consumes core-host + local API contracts
  ├── consumes cloud-client
  ├── assembles runtime artifacts
  └── assembles extension-pack
```

Regras:

1. Nenhum `workspace:*` cruza repositórios.
2. Nenhum alias para `src`, path relativo, submodule ou dependência Git cruza repositórios.
3. O produtor publica contrato e compatibilidade; o consumidor fixa versão exata no BOM do Desktop ou lockfile do repo.
4. Contratos não importam store, framework HTTP, Electron, Cloudflare bindings ou implementação.
5. Não pode existir ciclo entre repositórios.
6. Deep imports só existem se declarados em `exports` estáveis e testados como API pública.
7. Scope e nomes serão renomeados depois da extração; não combinar rename massivo com movimentação de histórico.

## 6. Invariantes de comportamento

A migração precisa preservar:

- backend in-process no Desktop até o `core-host` provar o mesmo comportamento; nenhum localhost em produção;
- CLI e MCP stdio como produtos suportados do Core;
- request/stream semantics e tipos do bus local;
- refresh token do desktop restrito ao main process; Portal continua com sessão web própria;
- migrations SQLite/D1, diretórios de dados e formatos persistidos;
- assinatura, hash e moderação de plugin antes de instalação;
- build determinístico e ordem estável do extension-pack;
- policy, approvals, fencing, budgets, dedupe e `outcome_unknown` do runtime;
- generated Protobuf reprodutível e checks de breaking change;
- ABI de native modules, ASAR closure e smoke do instalador;
- rollouts/canários com receipts e rollback exercitado;
- recursos Cloudflare existentes, sem recriação acidental por mudança de repo.

## 7. Fases e gates

### Fase 0 — preservar o estado

Ações:

1. enviar ou salvar os dois commits locais ainda não presentes no remote;
2. classificar/preservar a alteração do gitlink Unity e diretórios locais;
3. criar tag imutável pré-split e backup do bundle Git;
4. registrar commit, recursos Cloudflare e hashes dos artifacts candidatos;
5. escolher registry privado, scopes, visibilidade e owners em ADR.

Gate de saída:

- working tree rastreada limpa;
- nenhuma alteração local sem owner;
- tag/backup restaurável testado;
- inventário de secrets e recursos produtivos aprovado.

### Fase 1 — higiene e mensuração

Ações:

1. remover do índice somente artifacts cuja regeneração resulte em diff zero;
2. ignorar outputs, tsbuildinfo, logs e metadados locais;
3. padronizar pnpm e um lockfile por futuro repo;
4. substituir o auditor raiz por análise package-aware;
5. adicionar ratchet de imports entre os seis domínios;
6. adicionar CI geral de Core/Desktop hoje ausente;
7. criar manifests para apps/extensões ou regras explícitas de ownership.

Gate de saída:

- `pnpm install --frozen-lockfile` em clone limpo;
- nenhum artifact gerado indevido rastreado;
- zero nova violação de fronteira;
- baseline de dívida somente diminui;
- secret scan do histórico verde ou exceções formalmente tratadas.

### Fase 2 — seams producer-owned

Ações Cloud:

- definir schema versionado para rotas, DTOs e erros;
- mover `CloudContract`/route map ao package do produtor;
- gerar ou validar client;
- migrar Portal, Core e Desktop;
- adicionar diff de breaking change e contract tests.

Ações Market:

- unificar `MarketInfo` e `MarketPluginInfo`;
- publicar market-client;
- adicionar integração local D1/R2;
- testar publish→pending→approve→search→download→rehash→verify→install;
- testar tamper, chave errada, SHA divergente, plugin não aprovado e bundle ausente.

Ações Plugin Platform:

- tornar provider contracts independentes de `shared` e runtime host;
- mover helper de authoring puro para o SDK;
- eliminar imports de code-agent/indexer/store das extensões;
- empacotar CLI e SDK em tarballs;
- definir conformance e compatibilidade de manifests.

Ações Runtime:

- versionar package pelo próprio repo;
- produzir artifact sem escrever em `dist/apps/electron`;
- publicar manifesto/checksum/SBOM por target;
- consumir somente provider contract publicado;
- preservar Buf breaking e geração reproduzível.

Ações Core/Desktop:

- criar `core-host` com lifecycle, dispatch, streaming, métricas e shutdown;
- eliminar todos os acessos `BackendHandle.local`;
- mover DTOs e utilitários usados pelo dashboard para contracts/UI packages públicos;
- testar host in-process e preparar adapter utilityProcess sem obrigar cutover.

Gate de saída:

- cada package externo passa `npm pack` e testes instalando o tarball;
- nenhum consumidor usa source path ou alias externo;
- contratos têm testes de compatibilidade producer/consumer;
- cada futuro repo constrói numa sandbox sem sibling checkout.

### Fase 3 — extrair Plugin Market

Por que primeiro: menor grafo de dependências e ciclo operacional já independente.

Procedimento:

1. extrair histórico relevante com `git filter-repo`;
2. criar pnpm workspace/lock, CI, secret scan e deploy environments;
3. importar recursos D1/R2 por IDs existentes, sem recriar;
4. publicar market-client RC;
5. migrar Core/Plugin Platform para a RC;
6. executar integração e rollback;
7. remover cópia do monorepo.

Gate de saída:

- deploy staging e produção manual verde;
- fluxo completo e negativos verdes;
- Core instala versão pinada;
- rollback para Worker/client anterior exercitado.

### Fase 4 — extrair Cloud

Procedimento:

1. extrair Worker, packages, Portal, migrations, docs e histórico;
2. criar lock e pipelines do repo;
3. vincular recursos existentes e secrets por environment;
4. publicar cloud-client RC;
5. migrar consumidores e fazer canário/staging;
6. aplicar migrations expand/contract;
7. remover cópia original.

Gate de saída:

- health, auth, refresh, CORS, billing básico e Portal verdes;
- migrations testadas em local e staging com backup;
- deploy produtivo continua manualmente aprovado;
- Core/Desktop compilam com client publicado.

### Fase 5 — extrair Plugin Platform

Procedimento:

1. extrair SDKs, extensões, CLI e testes;
2. substituir gitlink Unity por artifact pinado após recuperar origem/licença;
3. publicar SDK/provider contracts RC;
4. compilar cada extensão somente contra tarballs publicados;
5. gerar extension-pack reproduzível, assinado e indexado;
6. migrar Core/Desktop para as versões pinadas.

Gate de saída:

- zero import de code-agent/indexer/store/provider-runtime host-side nas extensões;
- exemplos third-party passam em clone limpo;
- bundles incompatíveis/tampered são rejeitados;
- Desktop monta o pack sem checkout do repo.

### Fase 6 — extrair Agent Runtime

Procedimento:

1. extrair Rust, contracts, host, scripts e docs;
2. criar lock/versionamento/release próprios;
3. publicar host/contracts TS e matrix de artifacts;
4. migrar Core e Desktop para versões pinadas;
5. manter gates funcionais G0-G7 no repo novo sem declará-los concluídos por causa do split.

Gate de saída:

- Buf lint/build/breaking e geração reproduzível;
- Cargo fmt/clippy/test/audit/deny e matrix de targets;
- package verify/smoke e process-real nos targets suportados;
- artifact não depende de package/config Electron;
- rollback do BOM para runtime anterior exercitado.

### Fase 7 — separar Core e Desktop

Procedimento:

1. transformar o repo principal em `codestudio-core` ou extrair Core preservando o histórico principal;
2. mover Electron/dashboard/release ao Desktop;
3. consumir Core por `core-host`/contracts publicados;
4. manter inicialmente host in-process, sem reintroduzir deep imports;
5. montar runtime e extension-pack pelo BOM;
6. validar instaladores em Windows, macOS e Linux;
7. remover aliases/shims após duas RCs equivalentes.

Gate de saída:

- Core: CLI, MCP stdio, HTTP API e host process-real verdes;
- Desktop: unit/visual/E2E, ASAR closure e installer smoke verdes;
- abertura de projeto, indexação, busca, agente, terminal, Cloud e plugin funcionam sem sibling checkout;
- nenhuma referência `@apps/http-api`, store/services/code-agent internals ou source alias no Desktop.

### Fase 8 — encerrar o super-repo

Ações:

- mover issues, docs, CODEOWNERS e workflows ao dono;
- configurar Changesets/SemVer e Renovate/Dependabot;
- congelar o repo antigo como referência/redirect;
- retirar shims e baselines zerados;
- publicar ADR final e runbook de releases coordenadas.

Gate de saída:

- dois release candidates e uma release estável construídos somente dos novos repos;
- repo antigo não participa de build/deploy;
- restores e rollbacks testados.

## 8. Estratégia de histórico

- Usar `git filter-repo` com path renames por destino; não copiar pastas sem histórico.
- Registrar o commit de origem em cada novo README e primeira release.
- Repetir a extração em rehearsal antes de criar os repos oficiais.
- Preservar tags relevantes por domínio, renomeando apenas colisões documentadas.
- Não executar rewrite com working tree suja ou trabalho local não classificado.
- Não usar submodules para recompor o produto; integração acontece por registry/releases.

## 9. Versionamento e release

- SemVer por package/repo.
- Changesets para packages TS publicados.
- Conventional commits/changelog por repo, sem obrigar versão única global.
- Desktop mantém BOM com versões exatas de Core, Cloud client, Market client, runtime e extension-pack.
- Runtime e extension-pack publicam checksums, provenance e SBOM.
- Atualizações entre repos chegam por PR automatizado e passam contract/integration tests; não há promoção automática a produção.
- Breaking changes usam expand/migrate/contract e janela de compatibilidade; não são coordenadas por branch compartilhada.

## 10. Validação mínima por repositório

| Repo | Checks obrigatórios |
|---|---|
| Core | install frozen, manifests, typecheck, unit/integration, CLI, MCP stdio, HTTP API, core-host, migrations, pack/install |
| Desktop | install frozen, typecheck, renderer unit/visual, Electron smoke, ASAR closure, native ABI, installer por OS |
| Cloud | install frozen, Worker types/typecheck, unit, D1 migrations local/staging, Portal build/E2E, secret scan, deploy staging |
| Market | install frozen, Worker typecheck/unit, D1/R2 integration, crypto vectors, moderation, publish/download/install, deploy staging |
| Plugin Platform | install frozen, SDK build/pack/install, conformance, cada extensão, deterministic bundle, assinatura/compatibilidade |
| Agent Runtime | Buf, generated diff, TS host/contracts, Cargo fmt/clippy/test/audit/deny, targets, package verify/smoke/perf |

Checks transversais:

- gitleaks em todo histórico extraído;
- licença e dependency review;
- zero source-path/submodule/dependência Git entre repos;
- zero secret em Git/artifact/log;
- restore/rollback exercitado;
- observabilidade e runbooks atualizados.

## 11. Rollback

- Código consumidor sempre usa versão pinada; rollback troca BOM/dependency para a versão anterior.
- Cloud/D1 usa migrations expand/contract e backup; rollback de app nunca executa downgrade destrutivo.
- Market mantém Worker/client/key-id anterior durante a janela de canário; chave privada não é rotacionada como efeito colateral do split.
- Extension-pack anterior permanece disponível e pinado.
- Runtime anterior permanece no feed e compatível durante a janela definida; mutações ambíguas nunca são repetidas.
- Core/Desktop mantêm duas RCs comparáveis antes de remover o build antigo.
- Tag pré-split e bundle Git permitem reconstruir o estado original sem depender dos novos remotes.

## 12. Incertezas e ADRs obrigatórias

1. **Registry e visibilidade:** GitHub Packages, npm privado ou registry próprio; definir autenticação de CI e desenvolvimento.
2. **Scope final:** manter aliases temporários `@mcp/*` ou adotar `@codestudio/*`; renome somente após o split.
3. **Provider contract ownership:** Plugin Platform é o candidato por ser superfície de authoring; validar que Agent Runtime usa apenas `ChatProvider`/wire e não cria ciclo.
4. **Core host transport:** in-process primeiro; utilityProcess é evolução separada, não pré-condição do split.
5. **Unity:** recuperar URL, licença, histórico e mecanismo atual do gitlink antes de qualquer remoção.
6. **Artifacts provider-sdk:** confirmar o motivo histórico dos outputs em `src`; a regra-alvo é gerar em diretório limpo e não rastrear build output.
7. **Pacotes sem consumidor:** `worker-pool` e outros candidatos só são removidos após AST, Knip, testes e busca em scripts/runtime.
8. **UI compartilhada:** design/app/sprite studio ficam no Core inicialmente; qualquer package UI independente exige browser-safe build e ownership explícito.
9. **Recursos Cloudflare:** confirmar ownership/account/environment de todos os IDs antes do rehearsal.
10. **Histórico:** definir quais tags/issues/releases migram para cada repo e quem aprova a reescrita.
11. **Assinatura de release:** Authenticode/notarization e chaves de extension/runtime precisam de owner e secret store antes da primeira release estável.
12. **Custo de CI:** definir matrix completa por PR versus nightly sem reduzir gates de release.

Nenhuma dessas incertezas autoriza dependência de fonte entre repositórios. Quando a decisão estiver pendente, o código permanece no repo atual e o gate de extração continua fechado.

## 13. Definição de conclusão

A reorganização termina somente quando:

- os seis repos constroem/testam/empacotam em clones limpos e isolados;
- os produtos Cloud, Market, Core, Desktop, Plugin Platform e Runtime têm CI/release próprios;
- Desktop é montado exclusivamente de artifacts versionados e pinados;
- nenhum repo depende de checkout irmão, source alias, submodule ou Git dependency;
- contratos e compatibilidade são testados pelo produtor e consumidores;
- duas RCs e uma release estável passam os fluxos ponta a ponta;
- o super-repo não participa mais de build ou deploy;
- segurança, rollback, histórico e runbooks estão verificados.

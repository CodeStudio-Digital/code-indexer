# Providers, Plugins, Cloud e Segurança

## Visão geral

O projeto possui uma camada extensível para provedores de LLM, plugins, marketplace, cloud API, identidade, billing, sync, vault e segurança operacional. Os principais módulos são:

- `packages/provider-sdk`: contrato estável para providers.
- `packages/provider-engine`: materialização runtime de provider specs.
- `packages/plugin-sdk`: contrato de autoria/manifest de plugins.
- `packages/plugin-host`: runtime/worker host de plugins instalados.
- `packages/plugin-market-client`: client de marketplace.
- `worker-market`: Cloudflare Worker do marketplace de plugins.
- `services/cloud-api`: Cloudflare/D1/R2 backend para identidade, billing, sharing, sync, feedback e vault.
- `extensions/provider-*`: providers distribuídos como extensões.

## Provider SDK

`packages/provider-sdk/src/index.ts` é o contrato público para providers. Ele exporta wire format, adapter interfaces, credentials/auth, `defineProvider`, stream resilience e schemas de provider spec (`packages/provider-sdk/src/index.ts:1-18`). A versão do contrato é explicitamente pinada como `PROVIDER_SDK_VERSION = 1` (`packages/provider-sdk/src/provider.ts:14-18`).

A identidade visual de provider é renderer-safe: trafega via HTTP como strings/classes e não componentes React, para cruzar a fronteira com o dashboard sem acoplar renderer/server (`packages/provider-sdk/src/provider.ts:35-48`). Providers podem declarar forms de configuração administrativa via `ConfigField`/`ProviderConfigDescriptor`, com built-ins host-rendered para `api_key` e `base_url` (`packages/provider-sdk/src/provider.ts:50-86`).

Testes de conectividade recebem credenciais já resolvidas pelo registry, incluindo tokens OAuth refreshados (`packages/provider-sdk/src/provider.ts:88-94`). A superfície de provider definition inclui metadata, pricing, capabilities, auth descriptors, auth handlers, fetch dinâmico de modelos, test connection, criação de indexer e criação de coder (`packages/provider-sdk/src/provider.ts:115-183`). Providers OAuth de plugin dependem de `auth` declarativo + `authHandlers` imperativos; o host fornece primitives de PKCE, loopback e device-code (`packages/provider-sdk/src/provider.ts:149-167`).

## Provider engine

`packages/provider-engine/src/index.ts` transforma `ProviderSpec` declarativo em `ProviderDefinition` runtime, cria model discovery/connectivity e é a única camada que importa adapters concretos de code-agent/indexer (`packages/provider-engine/src/index.ts:1-17`). Isso mantém o SDK declarativo e o engine como boundary de adaptação.

O catálogo built-in vive em `packages/provider-engine/src/specs/index.ts` e arquivos irmãos; é a camada que enumera kinds built-in e alimenta engine/build path.

## Provider routes e overlays de plugin

A rota de coder providers retorna providers e models vindos do DB, enriquece com capabilities do registry e cai para `SUPPORTED_CODER_PROVIDERS()` se o store está vazio (`apps/http-api/server/routes/coder/providers.ts:6-42`).

`apps/http-api/server/plugin-providers.ts` é o composition root server-side que reconcilia specs built-in com provider specs vindos de plugins habilitados. Ele restaura built-ins, aplica overlay de plugin-contributed specs e remove kinds plugin-only stale (`apps/http-api/server/plugin-providers.ts:1-57`).

Workers têm overlay separado porque cada worker thread possui module graph isolado. `apps/http-api/workers/worker-plugin-providers.ts` carrega o mesmo conjunto de providers de plugin dentro do worker e engole falhas best-effort para preservar boot com providers built-in (`apps/http-api/workers/worker-plugin-providers.ts:1-34`).

## Plugin SDK

`packages/plugin-sdk/src/index.ts` expõe contrato de autoria/manifest de plugins, schemas/tipos de manifest e helpers de definição (`packages/plugin-sdk/src/index.ts:1-12`). O authoring surface inclui `tools`, `toolWindows`, `commands`, `themes`, `permissions` e `providers?: ProviderSpec[]`; `definePlugin()` retorna um `PluginModule` consumido por worker bundles e CLI extraction (`packages/plugin-sdk/src/define-plugin.ts:11-18`).

O módulo de plugin é intencionalmente declarativo: comentários indicam que o build CLI lê essa estrutura para extrair `.app.json`, excluindo handlers de tools (`packages/plugin-sdk/src/define-plugin.ts:21-34`).

O marketplace manifest schema define entradas de catálogo, kinds de source (`local`, `github`, `url`, `market`, `bundled`), policy de instalação/autenticação e metadata opcional de produtos/categoria (`packages/plugin-sdk/src/manifest/marketplace.schema.ts:1-42`).

## Plugin host e worker runtime

O provider loader do plugin host valida provider specs de plugins, aplica trust gating, seleciona schema completo para first-party bundled plugins e schema de third-party para o resto, bloqueia kinds built-in reservados em plugins não confiáveis e registra definitions (`packages/plugin-host/src/provider-loader.ts:111-150`).

Estado de plugins habilitados é relido a cada run, então install/uninstall/enable entram sem restart (`packages/plugin-host/src/enabled.ts:1-6`). O overlay runtime coleta declarações de tools e worker bundle paths a partir do store de plugins instalados, usando apenas plugins habilitados (`packages/plugin-host/src/enabled.ts:26-47`).

A execução de plugins roda em worker thread, carregando bundles dinamicamente e mantendo runtime leve/spawn-free (`packages/plugin-host/src/worker/runtime.ts:2-5`). Bundles são carregados por import ESM absoluto de `dist/plugin.js`; tool registration vem do default export do módulo (`packages/plugin-host/src/worker/runtime.ts:22-49`). Falhas de tool invocation são normalizadas em `{ isError: true }`, evitando exceptions atravessarem a fronteira do worker (`packages/plugin-host/src/worker/runtime.ts:52-70`).

`apps/http-api/workers/plugin-worker.ts` executa bundles de plugin em worker isolado, suporta reverse host calls e preload de bundles antes de sinalizar readiness (`apps/http-api/workers/plugin-worker.ts:1-108`).

## Marketplace de plugins

`docs/PLUGINS.md` define plugin capabilities e compatibilidade com specs de Claude Code/Codex plugin (`docs/PLUGINS.md:1-18`). A anatomia inclui manifest, `.app.json` gerado, MCP/skills opcionais, source bundle, worker bundle e artifacts HTML de webview (`docs/PLUGINS.md:19-38`). O flow de instalação/runtime materializa namespace, captura snapshot de contributions, executa em worker thread e expõe namespace `plugins` na API (`docs/PLUGINS.md:99-118`).

O hosted market usa Cloudflare Worker com D1/R2 e bundles assinados Ed25519 (`docs/PLUGINS.md:202-225`). O fetch de marketplace verifica assinatura Ed25519 quando `MCP_MARKET_PUBKEY` está pinado; bytes não verificados não são extraídos nesse modo (`packages/plugin-host/src/sources/fetch-market.ts:7-12`). A materialização requer `MCP_MARKET_URL`, resolve latest version se ausente, baixa bundle, verifica assinatura e extrai em staging (`packages/plugin-host/src/sources/fetch-market.ts:18-35`).

`worker-market` expõe rotas públicas de catálogo/bundle e rota de publish protegida por Bearer; bundles publicados são assinados com Ed25519 (`worker-market/src/index.ts:2-11`). A autorização de publish/admin é um token Bearer único contra `AUTH_TOKEN` (`worker-market/src/index.ts:34-37`). Downloads retornam zip bytes com `X-Signature` e registram download server-side (`worker-market/src/index.ts:58-69`). O input de publish é filtrado por charset antes de virar path key no R2; novos bundles entram com moderação `pending` (`worker-market/src/index.ts:78-90`). Endpoints de moderação, como pending e approve, também são Bearer-protected (`worker-market/src/index.ts:93-105`).

## Company orchestration como integração

`CompanyOrchestrator` compõe runtime de empresa: lifecycle de master/subordinates, sandbox, board/kanban, pipeline execution, inbox routing, runtime reconciliation, service supervision, scheduler, drive store, event bus e autonomy provider (`packages/company/src/orchestrator.ts:1-154`). Patches de config persistem role assignments, skills, allowed models e autonomy patches em `CompanySession.config_json`, publicando `session.config_updated` (`packages/company/src/orchestrator.ts:227-253`).

## Cloud API: composição e identidade

`services/cloud-api/src/composition.ts` é o composition root de identity: liga env bindings a infrastructure e use cases de accounts, sessions, refresh/logout, 2FA, verification, password reset, OAuth identity resolution e access-token verification (`services/cloud-api/src/composition.ts:1-123`).

O OAuth identity repo mapeia `(provider, provider_user_id)` para account e insere linked identities em D1 (`services/cloud-api/src/infra/d1/oauth-identity-repo.ts:1-24`). Env secrets incluem valores explicitamente dev-only ou secret-backed, como `EMAIL_DEBUG_LOG_BODY`, `ACCESS_SIGNING_SECRET` e `IP_HASH_SALT` (`services/cloud-api/src/env.ts:19-26`). OAuth provider secrets e OAuth state secret são opcionais; ausentes, rotas retornam 404/fail-soft em vez de operação parcial (`services/cloud-api/src/env.ts:44-60`).

Admin API token e SSO config key são operator secrets; tokens ausentes/curtos ou keys ausentes desabilitam as surfaces correspondentes (`services/cloud-api/src/env.ts:63-70`).

## Billing e entitlements

`billing-composition` conecta D1 billing repo e Stripe gateway a checkout, portal, entitlement, webhook handling e reconciliation use cases (`services/cloud-api/src/billing-composition.ts:1-58`). Config Stripe vem do env e `portalBaseUrl` cai para `APP_BASE_URL` (`services/cloud-api/src/billing-composition.ts:24-33`). O bundle de billing expõe entitlement resolution, webhook handling, checkout, portal, reconciliation, gateway e repo (`services/cloud-api/src/billing-composition.ts:45-57`).

Rotas de billing expõem entitlement lookup, checkout, portal, sync/reconciliation e webhooks Stripe (`services/cloud-api/src/routes/billing.ts:25-116`). Webhook handling inclui verificação de assinatura sobre raw body e projeção de org events em D1. O webhook diferencia eventos pessoais e org/per-seat, registra processamento idempotente e upserta org subscriptions no teams repo (`services/cloud-api/src/routes/billing.ts:78-115`).

Billing é fail-soft: sem secrets Stripe, rotas retornam 501; sem share signing key, criação de share retorna 501 (`services/cloud-api/src/env.ts:27-36`).

## Sharing e sync/vault

`sharing-composition` liga share repo, Ed25519 signer e billing entitlements; se o signer não existe, create-share fica indisponível (`services/cloud-api/src/sharing-composition.ts:2-5`). O bundle fornece create/get/list/revoke e acesso a entitlements; `signerConfigured` deriva da presença da signing key (`services/cloud-api/src/sharing-composition.ts:29-40`).

Rotas de sync são Bearer-protected e entitlement-gated; o cliente remove secret env values antes de push, então o server não recebe/não armazena secrets (`services/cloud-api/src/routes/sync.ts:2-7`). Payloads vault são limitados a 64 KiB por record, enquanto docs não-vault aceitam 1 MiB (`services/cloud-api/src/routes/sync.ts:34-40`). Kinds vault exigem entitlement `sshVault`; docs não-vault exigem `sync` (`services/cloud-api/src/routes/sync.ts:55-64`). Push requer email verificado, rate limiting, resolve entitlements e rejeita misturas vault/plain não autorizadas antes de reconciliation (`services/cloud-api/src/routes/sync.ts:81-97`). Pull tem rate limiting e entitlement gate próprios (`services/cloud-api/src/routes/sync.ts:100-115`).

## Account lifecycle, vault keys e erasure

Account vault-key endpoint publica apenas a ECDH public key do usuário, para admins embrulharem Team Vault Key; private key nunca é enviada ao server (`services/cloud-api/src/routes/account.ts:34-43`). Account export agrega identity, billing, sharing e feedback do usuário autenticado (`services/cloud-api/src/routes/account.ts:72-98`). Account deletion reautentica com senha atual, apaga blobs R2 antes de hard-delete e registra audit event sincronamente (`services/cloud-api/src/routes/account.ts:101-130`). O arquivo documenta export/erasure como caminhos GDPR/LGPD com hard-delete semantics (`services/cloud-api/src/routes/account.ts:2-6`). A purga de R2 vem antes do DB hard-delete porque cascades do DB não chegam ao object storage; audit é persistido antes da resposta (`services/cloud-api/src/routes/account.ts:124-129`).

## Cloud contract e desktop transport

O contrato cloud é separado do API bus local. `CloudContract` define operations como auth, billing, sharing, docs publish/list/revoke, sync push/pull, org/team workspace, vault e feedback (`packages/api-bus/src/cloud/contract.ts:133-205`). `CloudFetchResult` é o shape de retorno do main process para o renderer, e `CloudAuthState` é o broadcast de auth state (`packages/api-bus/src/cloud/contract.ts:206-218`).

No Electron, cloud transport usa HTTPS low-level, anexa access token, aplica timeout e tenta refresh único após 401 (`apps/electron/src/cloud/cloud-transport.ts:1-8`). Headers carregam desktop/version/OS/device; non-GET serializa JSON (`apps/electron/src/cloud/cloud-transport.ts:36-53`). Erros de rede viram resposta offline estruturada (`apps/electron/src/cloud/cloud-transport.ts:55-72`).

## Security/trust boundaries

- **Plugin marketplace**: baixar → verificar assinatura se `MCP_MARKET_PUBKEY` estiver setado → extrair. Sem verificação, bytes pinados não são aceitos (`packages/plugin-host/src/sources/fetch-market.ts:7-12`).
- **Plugin runtime**: worker threads isolam execução e normalizam falhas como tool result error (`packages/plugin-host/src/worker/runtime.ts:2-70`).
- **Worker provider overlay**: duplicado por module graph isolado e fail-soft para não quebrar built-ins (`apps/http-api/workers/worker-plugin-providers.ts:1-34`).
- **Cloud API secrets**: Stripe, share-signing, OAuth, admin e SSO secrets ausentes desabilitam features em vez de operar parcialmente (`services/cloud-api/src/env.ts:27-70`).
- **Vault/sync**: vault records têm limite menor, entitlement específico e server não deve receber secrets de env (`services/cloud-api/src/routes/sync.ts:2-97`).
- **Account deletion**: R2 purge antes de DB hard-delete evita blobs órfãos (`services/cloud-api/src/routes/account.ts:101-130`).

## Design choices observados

- Provider contract é estável e declarativo; engine é a boundary para adapters concretos.
- Plugins podem contribuir providers, tools e UI, mas passam por trust gating e worker isolation.
- Marketplace suporta assinatura Ed25519 e moderação.
- Cloud contract é separado da API local, reduzindo acoplamento entre desktop e worker remoto.
- Cloud API prefere fail-soft por configuração ausente, desabilitando features sensíveis.
- Vault e sync são entitlement-gated e size-bounded.

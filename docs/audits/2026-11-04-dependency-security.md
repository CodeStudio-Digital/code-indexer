# Dependências de segurança — 2026-11-04

O manifesto, o lockfile e a instalação efetiva foram atualizados de forma restrita para `shell-quote` 1.11.0 e `proxy-addr` 2.0.8. As 15 regressões passaram e a nova auditoria de produção não reporta vulnerabilidades críticas. Ainda existem achados de outras severidades, detalhados abaixo.

## Decisão e fontes

- `shell-quote` 1.8.3 permite terminadores de linha em tokens de operador. A primeira correção saiu em 1.8.4, conforme o [advisory do mantenedor GHSA-w7jw-789q-3m8p](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p).
- A consulta atual revelou outro advisory que afeta **1.8.4 até antes de 1.11.0**, envolvendo uma string com terminador de linha depois de um token de comentário. Por isso o override usa **1.11.0**, mínimo que cobre ambos os casos, e não 1.8.4. A decisão segue o [advisory GHSA-pqg4-j6r4-53mv](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv) e a [release oficial v1.11.0](https://github.com/ljharb/shell-quote/releases/tag/v1.11.0).
- `proxy-addr` 2.0.7 aceita determinadas sub-redes IPv6 como confiança para qualquer IPv4. O mínimo corrigido é **2.0.8**, conforme o [advisory GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h). A exploração depende da configuração de proxies confiáveis; a presença da dependência não prova exploração do CodeStudio.

## Escopo comprovado do lockfile

- Apenas dois pacotes adicionados e dois removidos: `shell-quote` 1.8.3 → 1.11.0, `proxy-addr` 2.0.7 → 2.0.8.
- Consumidores atualizados: `@scalar/api-client` 2.2.62, `concurrently` 9.2.1 e `express` 5.2.1.
- Sem outros upgrades, mudanças de importer ou remoção dos overrides já existentes. Integridades foram obtidas pelo pnpm, sem edição manual.
- `pnpm install --lockfile-only --ignore-scripts` concluiu com exit 0. Durante essa fase, os hashes de `.modules.yaml` e do lock instalado permaneceram iguais.
- O lock instalado já continha 15 pacotes órfãos ausentes do lock atual **antes** desta alteração. A instalação congelada pode retirar esses resíduos; isso é distinto dos dois upgrades introduzidos aqui.

Snapshot, diff e comparação: `.tmp/harness-retest-2026-11-04/deps/{before/,before-hashes.json,lock.diff,lock-verification.json,lock-update.log}`.

## Regressão segura

O baseline invocou exclusivamente funções de quoting e endereço, sem shell, HTTP, listener ou acesso externo. Os dois consumidores reais carregavam `shell-quote` 1.8.3 e aceitavam newline em `.op`. O Express carregava `proxy-addr` 2.0.7; uma requisição sintética com conexão `203.0.113.10` e confiança `::ffff:10.0.0.0/8` devolveu o IP arbitrário de `X-Forwarded-For`, reproduzindo a condição do advisory.

Evidência: `.tmp/harness-retest-2026-11-04/deps/baseline-probe.json`. A regressão preparada cobre os quatro terminadores de linha, preservação de strings/operadores/globs, endereços não confiáveis e sub-redes IPv4/mapeadas corretas. Não há execução de payload de shell.

## Validação final

- `pnpm install --frozen-lockfile --ignore-scripts` concluiu com exit 0, após encerramento da suíte geral. Houve dois downloads; os demais vínculos/reutilizações refletem a reconciliação do workspace e dos resíduos anteriores (`install-patched.log`).
- Os consumidores `concurrently` e `@scalar/api-client` efetivamente carregam `shell-quote` 1.11.0. O `express` carrega `proxy-addr` 2.0.8. No probe pós-instalação, os tokens perigosos são recusados e a origem da conexão prevalece sobre o XFF não confiável (`patched-probe.json`).
- **15/15 testes passaram** em `src/__tests__/dependency-security-regressions.test.ts`, cobrindo os quatro terminadores de linha e compatibilidade de strings, operadores escapados, globs e sub-redes válidas. Relatório: `.tmp/harness-retest-2026-11-04/prompts/dependency-security.json`.
- Typecheck canônico do projeto no host passou com exit 0 depois da instalação e das anotações de tipos finais nos testes (`typecheck-host.result.json`, 22,8 s). A tentativa anterior no sandbox teve falhas de resolução/tipagem que não se reproduziram no host.
- Os SHA-256 dos cinco binários nativos verificados (SQLite, três bindings PTY e Sharp) são idênticos antes/depois. Um banco SQLite em memória abriu no Electron 42.5.0 / Node 24.17.0, ABI 146, SQLite 3.53.2, antes e depois. `keytar` não está instalado em nenhum dos dois estados. Evidências: `native-before.json`, `native-after.json`, `abi-before.json`, `abi-after.json`.
- `pnpm audit --prod --json` reportou **0 críticos, 75 altos, 83 moderados e 13 baixos**. Não restam advisories para os dois pacotes tratados. O exit 1 permanece por esses 171 achados; isso não equivale a ausência global de vulnerabilidades ou a prova de exploração das dependências restantes.

Auditoria bruta: `.tmp/harness-retest-2026-11-04/deps/audit-prod-patched.json`. Resumo de testes, severidades e hashes: `deps/security-result.json`. Build e testes gerais integrados são registrados pela auditoria principal do harness.

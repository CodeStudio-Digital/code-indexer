# CodeStudio 3.15.10 — respeitar Sem Impedimento com incidentes antigos

## Causa confirmada

A versão 3.15.9 ainda avaliava a recuperação antes do modo escolhido. Qualquer incidente antigo de resultado desconhecido transformava novas escritas/comandos em pedidos de autorização. A revisão persistente adicionada naquela versão funcionava, mas exigia uma decisão adicional para fazer valer uma permissão já concedida pelo usuário.

O estado real do chat foi consultado somente em leitura: `permissions.mode` estava em `unrestricted`, com o incidente `call_2979d0a3c67242faa8a65ccee19b7e8b` (`code_exec`) ainda desconhecido e nenhuma resolução registrada. Portanto, não era perda da configuração. Nenhum dado do chat foi alterado.

## Correção

- Em Sem Impedimento, novas ações autorizadas não pedem uma revisão só porque existe um incidente antigo. Gate e Registry consultam a mesma política e o modo atual.
- O host indexa as assinaturas de operações pendentes e revisadas. Repetir exatamente uma dessas operações continua exigindo autorização específica. Evidência incompleta não permite presumir que a chamada é nova.
- A troca de modo durante uma espera reavalia o cartão aberto por evento, sem polling. Se a nova chamada estiver autorizada, ela prossegue sem marcar o incidente como revisado ou bem-sucedido.
- `code_exec`, subagentes, agentes em segundo plano e retomadas usam a mesma decisão. A proteção contra novos efeitos dentro de uma tentativa que acaba de perder o resultado permanece.
- Escritas em banco mantêm a autorização própria. Os modos Perguntar/Auto mantêm a recuperação explícita. Prompts e tooltip explicam essas regras.
- A restauração do modo não cria resolução artificial, não apaga histórico e não executa novamente a operação antiga.

## Validação

Foram aprovados **1.363 testes distintos**, incluindo 13 regressões novas para esta política. A execução ampliada inicial teve três expectativas de texto antigas, atualizadas para o comportamento desejado, e um teste de rollback/fork que excedeu 20 segundos sob quatro workers. O teste de armazenamento passou sem alterações no reteste isolado; não restaram falhas. Os 54 testes de política, prompts, traduções e cartão de aprovação passaram após o último ajuste de texto. TypeScript e `git diff --check` passaram.

O mesmo cenário sintético é executado nos módulos reais dos pacotes 3.15.9 e 3.15.10, incluindo FsSessionStore, Bootstrap, PermissionGate, Registry e `code_exec`. O cenário salva Sem Impedimento e mantém um `code_exec` antigo pendente, sem revisão humana.

Na 3.15.9, duas edições (uma após reinício), um comando novo e uma edição dentro de `code_exec` geraram **quatro pedidos de aprovação**; nenhuma ação foi executada porque a fixture nega pedidos. Na **3.15.10, as mesmas quatro ações executaram com zero pedidos**. O incidente antigo permaneceu desconhecido nas duas versões e nenhuma revisão foi fabricada.

O pacote novo passou também nas verificações de replay exato, aprovação própria de banco e troca ao vivo para Sem Impedimento com uma nova ação aguardando. O smoke anterior de recuperação passou nos oito grupos de verificações, incluindo recibos físicos tardios, perda de ACK, revisão persistente e retomada. Não restaram slots de aprovação pendentes.

A interface empacotada exibiu Sem Impedimento salvo e o tooltip corrigido. Os cartões para decisões que continuam necessárias passaram nos fluxos de executar, negar, revisar, falhar no envio e repetir a entrega. Foram seis grupos de verificações visuais, sem erros de página/console ou requisições inesperadas; capturas inspecionadas. As requisições de modelo/aprovação da fixture visual são interceptadas, e a política real foi validada separadamente nos módulos compilados.

A verificação de dependências e componentes nativos do candidato passou, incluindo renderer, parser, QuickJS, SQLite, MCP, cancelamento, paginação e Git. O ASAR e o executável permaneceram imutáveis durante os testes.

## Instalador

`D:\MCP\dist\electron-unrestricted-fix-20261104\CodeStudio Setup 3.15.10.exe`

- Tamanho: **340.967.926 bytes**.
- SHA-256: `26763f401c491f9aebd4428b9f3f0333570fe328f714a758faccb3d3cb04550a`.
- ASAR testado: `5a10e91d18a777e57ac229179c34af57ad23f9d1bc315021026fc94dd281e13b`.
- Assinatura Authenticode: **NotSigned**, pacote local de desenvolvimento.
- Instalador 3.15.9 preservado, SHA-256 `8681597eb2e031136a4c3d8be588df180c74e610558f40126ec249df9282a61e`.

Não houve instalação ou alteração do perfil real. Após instalar a versão nova e reabrir o CodeStudio, novas ações do chat retomado seguem o modo salvo sem exigir o checkbox de revisão. Repetição exata de operação incerta e escrita em banco continuam com autorização específica.

Evidências: `.tmp/unrestricted-policy-2026-11-04/`, especialmente `observed-session.json`, `test-summary.json`, `packaged-before/report.json`, `packaged-after/report.json`, `packaged-recovery/report.json`, `candidate-validation-IVT9kq/manifest.json` e `packaged/runs/2026-11-04T22-58-18-740Z/report.json`. As fixtures usam dados sintéticos, sem provedores ou banco remoto. Esta entrega corrige a política de aprovação; não inclui novo benchmark geral de CPU.

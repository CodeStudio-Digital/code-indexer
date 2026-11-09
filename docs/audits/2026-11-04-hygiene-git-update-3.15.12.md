# CodeStudio 3.15.12 — Higiene e atualização Git

A correção trata o projeto ausente que reaparecia após confirmar a higienização e a atualização Git que recusava edições locais. O instalador é gerado separadamente da versão 3.15.11 e inclui as alterações anteriores presentes no workspace.

## Causas e mudanças

| Fluxo | Antes | Depois |
| --- | --- | --- |
| Projetos ausentes | A consulta de higiene incluía o projeto reservado `0 / __user__`, sem diretório, usado pela memória global. | A consulta exclui esse registro e projetos internos virtuais/avulsos. Exclusão e limpeza do projeto zero também são recusadas no banco. |
| Confirmação de exclusão | A rota contava tentativas como remoções e retornava sucesso mesmo com erro. | Conta apenas exclusões concluídas, apresenta falhas por projeto e usa a mesma cascata da exclusão normal, incluindo encerramento dos serviços do projeto. |
| Mudança no disco durante a confirmação | A lista antiga podia continuar considerando um diretório restaurado como ausente. | O diretório é consultado novamente antes da exclusão; erros de acesso não são confundidos com inexistência. |
| Atualizar com edições locais | `git pull --rebase` recusava alterações não commitadas. | O pull usa `--autostash`: o Git guarda e reaplica edições rastreadas, inclusive ao continuar ou abortar um rebase. |
| Conflito na reaplicação | O código zero do Git podia produzir uma indicação falsa de sucesso. | O resultado consulta arquivos não resolvidos no índice. A interface avisa e abre o painel de conflitos do repositório afetado. |
| Update Project | Executava fetch e depois outro fetch implícito no pull. | Executa um único pull e mantém a indicação de atividade durante a operação. |

A leitura do perfil real confirmou que o único registro marcado como ausente era o projeto reservado de memória global. Essa inspeção foi somente leitura; não houve exclusão de dados do usuário. A reprodução na versão 3.15.11 usou um banco sintético e mostrou uma resposta com duas supostas remoções, embora uma delas fosse o projeto zero e permanecesse no banco.

## Verificação

Os testes usam repositórios Git locais com remotos bare sintéticos, SQLite real e perfis Electron isolados. Nenhum pull, stash ou reset foi executado nos projetos reais do usuário.

- Higiene, proteção de memória, migrações, roteamento do banco e coordenação semântica: 102 testes aprovados.
- Git: sete cenários de atualização aprovados; outros 22 casos de operações de branches e resolução de conflitos aprovados.
- Interface de resultados Git: quatro casos aprovados, incluindo seleção do repositório correto e proteção contra trocar um projeto aberto enquanto a operação estava em andamento.
- Traduções: oito testes aprovados.
- Tipos do backend e dashboard, verificação de hooks React e diferenças sem erros de espaços em branco: aprovados.

São 143 casos distintos. As primeiras execuções tiveram uma falha exclusivamente na remoção síncrona das pastas temporárias pelo Electron no Windows; os sete cenários funcionais já passavam. A remoção assíncrona foi validada em nova execução completa, e as pastas remanescentes das tentativas anteriores foram removidas por caminhos absolutos conferidos. Os logs foram preservados.

A matriz Git cobre edições preparadas e não preparadas, arquivo novo, stash anterior, conflito de autostash, resolução e continuação de rebase, aborto de rebase, remoto indisponível, colisão de arquivo não rastreado e branch já atualizada. A atualização de outra branch mantém o comportamento existente de avanço somente quando possível, sem checkout forçado.

## Comportamento e limites

Conflitos que exigem escolher conteúdo continuam exigindo revisão. O CodeStudio apresenta os arquivos para resolução; não escolhe silenciosamente uma versão. Arquivos novos não rastreados permanecem no diretório, e uma colisão com um arquivo recebido interrompe a atualização preservando o conteúdo local.

O mecanismo usado é o autostash nativo do Git. A preservação do conteúdo foi verificada; não há promessa de preservar a separação original entre alterações preparadas e não preparadas para commit. A comparação funcional é com o recurso de guardar alterações antes da atualização disponível no WebStorm, não com a resolução automática de todo conflito.

Referências: [Git pull e autostash](https://git-scm.com/docs/git-pull) e [opções de atualização e preservação de alterações do WebStorm](https://www.jetbrains.com/help/webstorm/settings-version-control-git.html).

## Aplicativo empacotado e entrega

A versão 3.15.12 passou em **nove verificações de interface e persistência**, incluindo cancelar a confirmação, remover o projeto ausente, preservar um diretório restaurado durante a confirmação, rejeitar a exclusão direta do projeto zero, executar cleanup e limpeza de dados, atualizar pelo menu da branch e atualizar pelo botão Update Project com conflito. O banco foi consultado novamente após o fechamento para confirmar a preservação da memória global e dos registros internos. O teste final terminou sem erros de página e sem processos restantes da instância.

Evidências: [relatório da interface](D:/MCP/.tmp/hygiene-fix-20261104/runs/2026-11-05T01-18-43-400Z/report.json), [higiene após confirmação](D:/MCP/.tmp/hygiene-fix-20261104/runs/2026-11-05T01-18-43-400Z/after-confirmation.png) e [conflitos após atualizar](D:/MCP/.tmp/hygiene-fix-20261104/runs/2026-11-05T01-18-43-400Z/git-update-conflicts.png).

Na primeira execução da interface, o script de limpeza associou incorretamente um monitor antigo `git fsmonitor` (PID 39472, criado às 17h48) à árvore do teste por reutilização do PID de seu antigo pai no Windows, e o encerrou. O problema estava no script auxiliar de teste. A identificação agora exige que cada filho tenha sido criado depois de seu pai atual. A regra passou por um teste sintético de PID reutilizado e os nove cenários foram repetidos. Na execução final, todos os processos registrados foram criados após o início do teste e o encerramento ocorreu apenas por `application.close`, sem encerramento forçado. Evidência da proteção: [process-ownership-check.json](D:/MCP/.tmp/hygiene-fix-20261104/process-ownership-check.json).

A verificação nativa confirmou 2.463 módulos alcançáveis em 43 pacotes, sem módulos ausentes. Renderização, deep links, tree-sitter, QuickJS, conversão HTML, Sharp/FFmpeg, stdio, SQLite, cancelamento, paginação de saída e leitura Git passaram. O [manifesto nativo](D:/MCP/.tmp/hygiene-fix-20261104/candidate-validation-JYGxbd/manifest.json) confirma que o pacote permaneceu inalterado durante a validação. A checagem React registrou zero diagnósticos novos; os 476 diagnósticos legados continuam explicitamente registrados no baseline.

Entrega: [CodeStudio Setup 3.15.12.exe](<D:/MCP/dist/electron-hygiene-git-fix-20261104/CodeStudio Setup 3.15.12.exe>), Windows x64, 340.971.142 bytes. Instalador local sem assinatura Authenticode (`NotSigned`). O [registro final](D:/MCP/.tmp/hygiene-fix-20261104/release-final.json) consolida os 143 testes distintos, as nove verificações de interface e os hashes conferidos contra o executável testado.

```text
SHA256 instalador: 98AAE9625F357EDF3CAF1130784C9B56CC392380CBDE8F1603266988793E87B2
SHA256 app.asar:   47FDF8631432D0C57534409C48ABDE6C68B2EFE8A671C321008FEF2F6F5D40A5
```

Para aplicar, encerre a instância instalada do CodeStudio e execute o instalador acima. A instalação em uso foi preservada durante os testes; não houve commit, push ou publicação.

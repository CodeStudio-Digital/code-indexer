# CodeStudio 3.15.9 — recuperação persistente de operações incertas

## Problema corrigido

Uma chamada com `effect_outcome: unknown` mantinha a sessão em recuperação indefinidamente. O modo “Sem impedimento” continuava selecionado, mas cada nova alteração exigia aprovação. Aprovar uma chamada não encerrava a recuperação, e reinício/compactação reintroduziam a restrição. O tooltip omitia essa exceção.

## Comportamento entregue

- O host registra a resolução de cada ocorrência em um evento imutável do journal. O erro original permanece no histórico; uma resolução não fabrica sucesso.
- Resultados físicos tardios conhecidos são vinculados à execução, chamada, ferramenta e hash dos argumentos. Um recibo válido encerra a recuperação automaticamente. Se uma aprovação já estiver aberta, ela é liberada quando a política selecionada permitir aquela ação, sem polling.
- Um `code_exec` só produz recibo agregado depois do encerramento do avaliador e da conclusão física conhecida de todos os filhos. Fim da espera, timeout, texto retornado pelo modelo e resumo de chamadas não substituem essa prova.
- Para incidentes antigos sem recibo suficiente, o cartão mostra as chamadas pendentes e uma opção **desmarcada**: “Conferi o estado dos arquivos e processos das ações anteriores listadas”. A ação **“Executar e retomar modo”** registra essa revisão uma vez e restaura o modo selecionado para novas operações. **“Executar uma vez”** continua autorizando somente a chamada atual.
- Revisão humana é registrada como `user_acknowledged`, distinta de `verified_terminal`/`verified_not_applied`. O resultado original continua desconhecido. Repetir exatamente a operação incerta, inclusive o mesmo script `code_exec`, ainda exige aprovação específica.
- Negar não confirma revisão. Revisão não concede “sempre permitir”, nem contorna as regras de banco ou do modo “Perguntar”. A identidade do conjunto exibido impede aprovar incidentes que surgiram depois.
- A aprovação fica vinculada às ocorrências exibidas antes da espera, inclusive quando um provedor reutiliza o mesmo ID. Uma ocorrência nova invalida o consentimento anterior; a liberação automática também revalida a recuperação e o modo antes de continuar. O Registry consome a autorização da chamada uma única vez.
- Reinício, compactação, recorte de histórico e rollback da conversa não apagam a evidência. Cópias preservam o journal; uma cópia legada incompleta falha explicitamente em vez de perder incidentes.
- Subagentes usam identidades separadas e registram suas ocorrências no journal do pai. A resolução de uma chamada de um filho não libera um irmão com o mesmo ID do provedor.

## Correções relacionadas

O transporte HTTP aceita apenas booleanos reais para aprovação/concessão. Uma resposta perdida seguida da morte do worker não produz mais a afirmação “a ferramenta NÃO foi executada” nem a instrução de repeti-la. A ausência do worker preserva a incerteza.

Timeouts após o início de uma escrita/comando nativo recebem a mesma proteção de operações externas. Leituras, espera pela fila, cancelamento anterior ao dispatch e wrappers sem filhos com efeitos não criam falsos incidentes.

A interface mantém o pedido quando o HTTP falha e permite tentar a entrega novamente. Um evento repetido substitui o cartão antigo, e a revisão é vinculada ao fingerprint exibido. Textos e prompts em inglês/português explicam a recuperação e evitam uma segunda pergunta em prosa feita pelo agente.

## Limites de evidência

O incidente antigo mostrado pelo usuário incluía comandos e uma busca. Não há recibo persistente suficiente para afirmar automaticamente que todo o lote terminou ou não causou efeitos. A nova versão fornece revisão explícita durável para esse caso; nenhum incidente do perfil real foi marcado como resolvido por esta validação.

Snapshots preparados antes da escrita, resumos do proxy e ausência de processo depois de reiniciar não foram usados como confirmação. A proteção do mesmo attempt continua interrompendo a execução ao detectar incerteza; a recuperação permite prosseguir em uma continuação, sem repetir automaticamente a chamada original.

Durante uma pendência, chamadas com fronteira de shell/banco continuam conservadoras, mesmo quando seu nome sugere leitura. Os wrappers atuais de Git herdam configuração capaz de executar hooks/processos; a consulta de schema SQLite pode abrir uma conexão gravável e criar um arquivo ausente. A correção não transforma essas operações em leituras comprovadamente sem efeitos. A regra normal volta a valer após recibo ou revisão durável.

Não foram adicionados timers de varredura de histórico. Recibos comuns mantêm somente metadados limitados a 1.024 entradas; um teste com 1.200 recibos confirma ausência de novas leituras do journal e de gravações de resolução para operações normais. Não foi realizado novo benchmark geral de CPU nesta entrega.

## Validação e instalador

Foram aprovados **2.763 testes distintos**: 1.441 do dashboard, 1.314 da regressão do runtime e oito casos novos de concorrência na aprovação. Após a última alteração do gate, foram repetidos 56 testes diretamente afetados, além dos oito casos novos; todos passaram. A contagem elimina repetições entre execuções. TypeScript (`tsc --noEmit`) e `git diff --check` também passaram.

O smoke do runtime compilado passou em **oito grupos de verificações**: leitura durante recuperação; revisão única seguida de duas novas escritas; reinício/Bootstrap/replay exato; novo incidente e aprovação independente de banco; recibo físico tardio; falha de entrega da aprovação; perda de ACK depois de revisão persistida; importação de histórico tipado sem mensagens órfãs. Foram seis escritas em arquivos sintéticos, nenhuma execução de banco e nenhum slot de aprovação pendente ao encerrar. O módulo de permissões no ASAR tem o mesmo SHA-256 do módulo compilado validado.

A verificação do pacote também passou: 2.460 módulos alcançáveis em 43 pacotes, sem dependência faltante; renderer, deep link, parser em worker, QuickJS, conversão de HTML, Sharp/FFmpeg, MCP por stdio, SQLite filho, cancelamento, paginação de saída e Git. O ASAR e o executável permaneceram imutáveis durante os testes.

O smoke visual do aplicativo empacotado também passou: revisão inicialmente desmarcada, lista completa, reset quando muda o fingerprint, execução única, negativa mesmo com revisão marcada, revisão com erro HTTP e nova tentativa, concessão independente de banco. Os cinco payloads capturados foram corretos; nenhum erro de página/console ou falha de requisição inesperada. As capturas foram inspecionadas. A fixture intercepta apenas suas próprias requisições de mensagem/aprovação, sem chamar modelo ou autorizar ações reais; a persistência foi comprovada separadamente pelo smoke compilado. A primeira tentativa da fixture usou Enter sem enviar a mensagem e foi encerrada; o teste válido usa o botão Enviar.

Todos os processos próprios dos smokes foram encerrados, com inventário por PID e horário de criação. Evidências desta entrega: `.tmp/outcome-recovery-2026-11-04/`, incluindo `test-summary.json`, `candidate-validation-9lcty2/manifest.json`, `packaged-recovery-final/report.json` e `packaged/runs/2026-11-04T21-32-26-141Z/report.json`.

Instalador: `D:\MCP\dist\electron-outcome-recovery-20261104\CodeStudio Setup 3.15.9.exe`.

- Tamanho: **340.965.097 bytes**.
- SHA-256: `8681597eb2e031136a4c3d8be588df180c74e610558f40126ec249df9282a61e`.
- Assinatura Authenticode: **NotSigned**, pacote de desenvolvimento local.
- ASAR testado: `142e237b8161d276a7f96fce503ddd8d8808ece3ddb6ed955f0666d91f59121b`.

O instalador 3.15.8 permanece intacto, com o hash anterior `9d5b622362f2f241fc68b27f857cbe7751759d5a778ed576371c82a110b23a97`. Nenhuma instalação, publicação ou alteração do perfil real foi realizada.

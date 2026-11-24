# Empresa com IA no CodeStudio

**SPEC de produto e engenharia · Implementação na branch `codex/remove-rust-runtime` · 23 de novembro de 2026**

Na Central de agentes, a pessoa poderá escolher **Criar com IA**, descrever uma entrega e ajustar, por conversa ou por seletores, os projetos, a equipe, as skills e as primeiras tarefas. Antes de criar a empresa, verá quem faz o quê, em qual projeto, com qual modelo e como a entrega será aceita. A mesma tela servirá para reconfigurar uma empresa existente.

Recomendo começar pela criação assistida e pelo controle das tarefas. As duas funcionalidades já trazem valor com o modelo de conversa configurado no CodeStudio. O Cloudflare Clef entra como recurso opcional para duas decisões delimitadas, a recomendação de um responsável em Company e a sugestão de um perfil em um chat comum.

## 1. Base do CodeStudio antes desta entrega

| Área | O que existe na branch | Consequência para o projeto |
| --- | --- | --- |
| Criação | O assistente atual pede nome, projetos e modelo do coordenador. Aceita template. A API exige nome e pelo menos um projeto, resolve os vínculos dos papéis e grava a sessão Company. | Aproveitar o formulário como caminho manual e a mesma validação do servidor para aplicar a proposta da IA. [Formulário](../../apps/dashboard/features/agents/NewCompanyDialog.tsx) · [Criação da sessão](../../apps/http-api/server/routes/company/session-files.routes.ts) |
| Equipe | Cada papel pode ter provedor, modelo, esforço, skills simples ou condicionais e vínculo com projetos. O template usa referências simbólicas de projeto. A sessão resolve os IDs concretos. `initialTools` apenas destaca ferramentas no catálogo. | Reaproveitar o contrato de papéis. O seletor deve distinguir ferramentas em destaque das permissões efetivamente impostas pelo executor. [Contrato de papel](../../packages/company-contracts/src/models/template.ts) · [Resolução de projetos e modelos permitidos](../../apps/http-api/server/routes/company/session-create-validation.ts) |
| Tarefas | O quadro já tem cinco colunas, checklist, comentários, dependências e agentes ligados a execuções. O planejador em lote valida ciclos e expressa indicação de papel por comentário. O serviço barra avanços com dependências abertas. | Promover o responsável a um campo editável e aproveitar o grafo e o bloqueio já existentes. [Cartão](../../packages/company-contracts/src/models/kanban.ts) · [Planejador](../../packages/company/src/tools/kanban-plan-graph.ts) · [Regra de bloqueio](../../packages/company/src/services/KanbanService.ts) |
| Recomendações | A priorização já considera impacto, esforço, urgência, dependências e disponibilidade. A recomendação de papéis já considera capacidade, afinidade semântica, histórico e custo. | Expor os motivos na interface e usar esses resultados como referência para avaliar o ganho do Clef. [Prioridades](../../packages/company/src/kanban-priority/kanban-priority-pipeline.ts) · [Papéis](../../packages/company/src/role-pipeline/role-pipeline.ts) |
| Preview e QA | A navegação dá ao preview uma área permanente. Certos nomes de papel, inclusive `qa` e `verifier`, recebem a skill `qa-preview` por padrão ao serem salvos sem uma skill de QA explícita. Há rotas próprias para planos, execuções e artefatos. | Mudar apenas a navegação deixaria papéis de testes de API ou de análise com uma skill de navegador indesejada. A proposta trata as duas camadas. [Navegação](../../apps/dashboard/features/agents/zones/company-navigation.ts) · [Skill padrão](../../packages/company-contracts/src/qa-defaults.ts) · [Rotas de QA](../../apps/http-api/server/routes/company/qa/index.ts) |
| Chat comum | A sessão tem classificação local de intenção e um preflight que pode consultar um LLM para preparar o trabalho. O envio de uma sessão nova pode aguardar esse preflight e reaproveitar um resultado salvo. | Aproveitar a classificação existente. Uma consulta remota adicional no caminho de envio agravaria justamente o tempo que o usuário espera pela primeira resposta. [Classificação](../../packages/code-agent/src/agents/decision-engine.ts) · [Preflight](../../packages/services/src/services/task-preflight/preflight-pipeline.ts) · [Envio](../../apps/http-api/server/routes/coder/stream.ts) |

## 2. Como deve ser configurar uma empresa

**Exemplo de uso.** “Quero cruzar os contratos do Backend e da Intranet. Dois analistas podem trabalhar em paralelo, só para leitura. Um revisor consolida as divergências. Para o revisor, use ChatGPT, Sol 6.2, no máximo.”

| Passo | O que a pessoa vê e pode fazer |
| --- | --- |
| Abrir | A Central oferece **Criar com IA** e **Criar manualmente**. Na empresa existente, **Configurações → Ajustar com IA** parte da configuração atual. O rascunho reabre no ponto em que ficou. |
| Delimitar | À esquerda fica a conversa. À direita ficam **Projetos**, **Equipe e skills**, **Tarefas** e **Regras de execução**. A IA identifica Backend e Intranet no catálogo e mostra nome e caminho local para distinguir homônimos. A pessoa pode marcar, excluir ou fixar escolhas diretamente. |
| Montar a equipe | A proposta mostra um coordenador, um analista por projeto e um revisor com acesso aos dois. Cada papel tem responsabilidade, projetos, skills, provedor/modelo/esforço e motivo da indicação. O limite deste exemplo é de duas tarefas de execução simultâneas. A revisão fica bloqueada pelas duas análises. |
| Refinar | “Use o mesmo analista para os dois projetos” altera a equipe e mostra quais tarefas e vínculos mudam. Campos editados manualmente ficam fixados até a pessoa liberá-los. É possível aceitar só parte da sugestão, desfazer a última alteração ou voltar ao formulário. |
| Revisar e criar | O resumo reúne organograma, custo ou limite quando disponível, projetos, autonomia e primeiro lote de tarefas. **Criar empresa** abre a empresa na lateral com o quadro pronto. **Iniciar sessão** ou **Despachar tarefa** é uma ação posterior e explícita. |

**Descoberta.** Projetos, perfis de agente, templates, skills e modelos vêm dos catálogos habilitados da instalação. A IA pesquisa por texto e por finalidade, recebe uma página curta de candidatos e pode refinar a busca. O filtro de provedor é obrigatório quando a pessoa nomeia um. O host valida a combinação de provedor, ID do modelo e esforço suportado. Se “ChatGPT / Sol 6.2 / max” estiver indisponível, o campo fica pendente com o motivo e as opções do próprio ChatGPT. Uma escolha explícita de provedor só muda por ação da pessoa. Aplicar o mesmo princípio a skills desabilitadas e projetos com nomes ambíguos. [Busca de modelos](../../packages/indexer/src/indexer/providers/model-catalog-index.ts) · [Contrato de seleção usado em chats filhos](../../packages/code-agent/src/tools/child-chat-tools.ts)

**Qualidade da sugestão.** O modelo generativo pode propor um papel novo quando o catálogo não cobrir uma responsabilidade. A tela identifica o papel como proposta, explica a lacuna e permite aceitar sua inclusão na equipe. As skills referenciadas precisam existir. A IA deve justificar cada papel por uma entrega concreta, oferecer acumular funções quando há sobreposição e sinalizar uma tarefa sem dono. No exemplo, o revisor verifica a matriz de divergências com referências dos dois projetos.

**Modelo e dados da conversa de configuração.** O cabeçalho identifica qual provedor e modelo vão receber o pedido e permite trocá-los. Essa escolha é independente do modelo do coordenador da futura empresa. O configurador pode consultar metadados de catálogo autorizados e propor alterações no rascunho. O acesso ao conteúdo de um repositório exige seleção explícita desse projeto como fonte de contexto. Cancelar a geração ou perder a conexão mantém a última revisão salva disponível para edição manual.

**Escopo e edição.** Na primeira versão, o organograma representa um único coordenador (`master`) e seus papéis subordinados. A revisão usa um papel da própria equipe. O host aplica limites de projetos e capacidades no despacho. Só oferece “somente leitura” quando puder impor esse limite às ferramentas em todas as vias de execução daquele papel. Se faltar suporte, a revisão aponta a restrição pendente antes de criar. A configuração aprovada ganha uma revisão. Sessões novas a recebem e sessões existentes podem adotá-la quando estiverem inativas, com a diferença visível. O modo manual também funciona quando o modelo generativo estiver indisponível. [Edição de papéis](../../apps/dashboard/features/agents/session-view/RoleDialog.tsx) · [Adoção de configuração pelas sessões](../../apps/http-api/server/routes/company/children.ts)

### Contrato do rascunho e aplicação

- O rascunho local guarda ID, versão de esquema, revisão, empresa de origem quando houver, objetivo, projetos selecionados, papéis e seus vínculos, skills, regras, grafo inicial de tarefas e campos fixados. O histórico curto da configuração fica separado das conversas operacionais. A lista de empresas carrega metadados. Abrir um rascunho carrega o respectivo conteúdo.
- Mensagens da IA propõem operações tipadas, como atribuir um papel ou adicionar uma dependência, sobre uma revisão específica. O servidor valida o resultado inteiro, incluindo escopo, existência no catálogo, unicidade do coordenador, referências e ciclos. Se o usuário editar enquanto a IA responde, a resposta antiga vira uma diferença para revisão. Alterações manuais ou vindas de outra janela têm a mesma proteção contra sobrescrita.
- API proposta em `/api/company/drafts`. Criar ou reabrir um rascunho é independente de iniciar um worker. `PATCH /:id` exige `expectedRevision`. `POST /:id/proposals` gera uma proposta para essa revisão. `POST /:id/apply` recebe revisão e chave de idempotência e devolve o ID da empresa e o mapa de tarefas criadas. Um conflito retorna `409` com a revisão vigente. Uma escolha inválida identifica o campo a corrigir.
- Aplicar usa os serviços de criação existentes. Reservar IDs por rascunho e por tarefa, persistir o progresso e publicar a empresa completa na lateral por evento após a confirmação. Uma interrupção entre criar cartões e ligar dependências deve permitir retomar o mesmo lote. O planejador atual aceita sucesso parcial por item. Essa resposta, sozinha, é insuficiente para marcar um rascunho como aplicado. Uma nova tentativa com a mesma chave retorna a mesma empresa, inclusive após reiniciar o desktop.
- **Salvar como template** é opcional. O template reutiliza papéis, skills e vínculos simbólicos. Os projetos concretos, execuções e cartões pertencem à empresa criada. O catálogo de templates usa SQLite e os cartões ficam no diretório `company/kanban-cards` do bundle da raiz. Se salvar o template falhar depois que a empresa foi criada, mostrar a empresa e permitir repetir só o salvamento. [Templates](../../packages/store/src/company/templates.ts) · [Persistência do quadro](../../packages/company/src/services/company-kanban-files.ts)

## 3. Tarefas como centro de operação

O cartão precisa responder, sem abrir a conversa do coordenador, a quatro perguntas. **Qual é a entrega? Quem responde por ela? O que impede o avanço? Onde está a evidência?** Na captura, há um cartão com comentários e controles de priorização em inglês. A informação que permite agir deve aparecer antes da pontuação.

**Quadro e lista.** Manter as cinco colunas atuais. Oferecer uma lista compacta para janelas estreitas, filtros por projeto, responsável, sessão de execução e bloqueio, e ordenação manual ou por prioridade. No cartão, exibir projeto, responsável, dependência que bloqueia e estado da execução mais recente. No detalhe ficam objetivo, critérios de aceite, checklist, atividade e evidências. Ao recomendar uma prioridade, mostrar um motivo verificável, como “libera duas tarefas”. Atualizar, limpar ou desligar a ordenação sugerida deve preservar a posição manual. Usar o idioma da interface também nas ações de recomendação e nos erros. [Quadro atual](../../apps/dashboard/features/agents/KanbanTab.tsx)

| Transição ou ação | Regra e retorno visível |
| --- | --- |
| Pendências → A fazer | Definir entrega e projeto alvo. Pode ficar sem responsável enquanto aguarda atribuição. A pessoa pode escolher um papel ou comparar os candidatos habilitados e seus motivos. |
| A fazer → Em progresso | O despacho valida papel, escopo, dependências, capacidade e autonomia. Distinguir **Na fila**, **Iniciando** e **Em execução** pelo estado da tentativa. Só exibir agente em execução após confirmação do worker. Duplo clique, agendador e duas janelas disputam a mesma reserva do cartão. |
| Em progresso → Revisão | O agente entrega um resultado e vincula evidências aos critérios. Uma falha ou interrupção mostra o último evento, a tentativa afetada e a ação disponível. Uma execução cujo resultado seja incerto segue o fluxo existente de conciliação antes de novo despacho. |
| Revisão → Concluído ou A fazer | O revisor verifica os critérios obrigatórios da tarefa. Aceite registra autor e evidências. Devolver registra o motivo e preserva as tentativas anteriores. Reabrir trabalho concluído registra a mudança e recalcula os dependentes. |
| Bloquear, pausar ou cancelar | Dependências abertas continuam produzindo `blocked_by`. Mostrar o impedimento e quem pode resolvê-lo. Pausar ou cancelar a execução mantém cartão e evidências. O estado da empresa e o da tentativa aparecem separadamente. |

O quadro é compartilhado na raiz da empresa. Despachar a partir de uma sessão filha usa o worker daquela sessão e registra esse vínculo na tentativa. O responsável planejado existe antes da primeira execução e pode ser diferente do agente que tentou a tarefa ontem. Persistir no cartão, de forma aditiva, o papel responsável, os projetos alvo, os critérios e referências de evidência. Reutilizar o histórico de execuções e as reservas com token e geração. A revisão, o arraste, as ferramentas de agente e o agendador devem consultar a mesma regra de transição. [Despacho](../../apps/http-api/server/routes/company/kanban-dispatch.ts) · [Reservas](../../packages/company/src/services/scheduler/dispatch-claims.ts) · [Conciliação](../../apps/http-api/server/routes/company/kanban-dispatch-review.ts)

**Compatibilidade.** Um cartão antigo abre mesmo sem os novos campos. Um comentário existente com indicação de papel conta como sugestão até haver atribuição explícita. Exigir evidência para critérios marcados como obrigatórios dali em diante. Cartões concluídos mantêm sua conclusão e histórico. Ao reabrir uma dependência, avisar também sobre entregas dependentes já concluídas para revisão humana.

### Onde fica o Preview e QA

Retirar **Preview e QA** da navegação principal padrão de Company. Cada tarefa ganha **Validações**, com os meios pertinentes ao aceite, como teste de API, comando de build, revisão de documento ou verificação visual. Habilitar **Validação visual** na configuração da empresa ou em um cartão expõe as ações de preview e o executor configurado. Uma empresa dedicada a interfaces pode fixar esse painel na navegação.

Execuções antigas continuam acessíveis por seus links e por **Tarefas → Histórico de validações**, inclusive as anteriores à associação com cartões. Um plano em andamento continua mostrando progresso, aprovação e resultado. O filtro por cartão usa referências aos artefatos originais. Em configurações novas, o padrão visual passa a depender do tipo de validação escolhido. Templates antigos e papéis com `qa-preview` ou `qa-playwright` explícitos conservam sua configuração. O executor e as regras de aprovação de planos continuam sendo consultados quando aplicáveis. Esta mudança de navegação se restringe a Company. [Planos de QA](../../packages/company/src/tools/qa/qa-plan-gate.ts) · [Artefatos](../../apps/http-api/server/routes/company/qa/artifacts.ts)

## 4. Clef opcional em Company e nos chats comuns

Clef recebe um estado e perguntas tipadas. Para seleção entre opções, retorna probabilidades que o aplicativo pode validar e usar para se abster. Isso serve para escolher entre papéis elegíveis ou sugerir um perfil. A conversa de configuração, a descrição da equipe e os critérios de aceite continuam com o LLM generativo escolhido. A Cloudflare publica `@cf/cloudflare/clef-flash` (9B) e `@cf/cloudflare/clef` (27B). Proponho iniciar o piloto com Flash e comparar a versão maior no mesmo conjunto de teste antes de oferecê-la como alternativa. [Funcionamento descrito pela Cloudflare](https://blog.cloudflare.com/clef-decision-models/) · [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) · [Clef](https://developers.cloudflare.com/workers-ai/models/clef/)

| Superfície | Referência atual | Decisão candidata e efeito permitido |
| --- | --- | --- |
| Empresa | A busca de papéis elimina indisponíveis e ordena os elegíveis. | Usar uma pergunta `choice` para recomendar um papel entre até cinco candidatos elegíveis. Mostrar o resultado ao atribuir um cartão. A pessoa aceita ou escolhe outro. Projeto, modelo, limites e despacho continuam sob controle do host. |
| Chat comum | O perfil explícito e a classificação/preflight existente orientam o trabalho. | Se o perfil estiver em automático, sugerir entre os perfis elegíveis, por exemplo análise ou revisão. Disparar com a ação de pedir sugestão ou usar um resultado válido já disponível. Ao enviar, usar o perfil vigente imediatamente. Um resultado tardio só pode ser oferecido para uma ação futura. |

**Configurações independentes.** Em **Configurações → IA → Decisões**, o administrador habilita a integração, configura a conta e o limite de uso. O padrão inicial é **Desligado**. Enquanto a integração estiver habilitada, cada empresa e cada chat comum pode escolher **Herdar**, **Desligado**, **Avaliar em paralelo** ou **Sugerir**. Uma sessão Company herda da empresa, depois do padrão da instalação. Um chat comum herda diretamente da instalação. A política global de bloqueio e o teto de uso prevalecem. O painel mostra o valor efetivo e sua origem.

- **Desligado** gera zero requisições ao Clef, inclusive em segundo plano. A criação assistida, a classificação existente, o Kanban e o chat continuam pelos caminhos já disponíveis.
- **Avaliar em paralelo** compara a decisão remota com a referência em uma amostra limitada. A decisão do usuário e a ordem exibida seguem o comportamento vigente. **Sugerir** exibe uma sugestão válida e permite ignorá-la ou corrigi-la.
- A pessoa pode habilitar Clef em uma empresa e deixá-lo desligado em um chat ChatGPT, ou fazer o inverso. Um perfil, provedor, modelo, esforço ou responsável fixado elimina a respectiva consulta de decisão. O Clef nunca recebe o poder de iniciar agentes, trocar de provedor ou aprovar uma entrega.

### Adaptador e comportamento em falhas

Implementar no host um adaptador de decisões que reutiliza a conta e a credencial configuradas do provedor Cloudflare. O adaptador chama `POST /client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash` no domínio da API. O provedor de chat atual aponta para `/ai/v1`. A inferência tipada dispõe de uma rota própria e dispensa implantar um Worker. Enviar apenas a descrição curta que a pessoa escolheu avaliar e os atributos dos candidatos necessários, com identificadores locais substituídos por aliases. O painel de configuração informa o que segue para a Cloudflare. Transcrições integrais, arquivos dos projetos, credenciais e caminhos absolutos ficam fora desse corpo. [Provedor existente](../../extensions/provider-cloudflare/src/spec.ts) · [Contrato REST oficial](https://developers.cloudflare.com/workers-ai/models/clef-flash/)

Exemplo de corpo do piloto para uma tarefa sintética. O host mantém o vínculo entre cada alias e o papel concreto até validar a resposta.

```json
{
  "model": "clef-flash",
  "state": {
    "entrega": "Validar divergências entre duas descrições de contrato",
    "fase": "revisao",
    "candidatos": ["r1", "r2"]
  },
  "questions": {
    "responsavel": {
      "type": "choice",
      "instructions": "Qual papel é o mais adequado para validar a entrega nesta fase?",
      "criteria": {
        "r1": "Analista que levanta contratos e produz a matriz inicial",
        "r2": "Revisor que confronta a matriz com evidências dos dois projetos",
        "insuficiente": "Faltam dados para escolher um papel"
      }
    }
  }
}
```

O adaptador confere o sucesso da chamada, o esquema das respostas, os aliases e a distribuição de probabilidades. O limiar inicial proposto para exibir uma sugestão exige probabilidade de pelo menos 0,80 e diferença de pelo menos 0,15 para a segunda opção. Calibrar os dois valores por tipo de decisão. Vitória de `insuficiente`, empate, candidato removido, resposta inválida, cota excedida, erro de autenticação, indisponibilidade ou timeout devolvem o controle ao fluxo existente. A configuração mostra o motivo de uma credencial inválida.

Por ação elegível, fazer no máximo uma consulta em lote, com orçamento inicial de 800 ms, cancelável e fora do caminho crítico do envio, retomada de chat e despacho. Deduplicar chamadas em andamento. Resultados em cache expiram e só valem para o mesmo escopo, estado reduzido, modelo, versão de perguntas e revisão dos candidatos. Desligar a integração cancela consultas em voo e descarta seus resultados. O host aplica limite de concorrência e de consumo. Telemetria registra decisão, origem, latência, abstenção, uso e aceitação ou correção. Registrar tokens efetivos quando informados e identificar custos estimados e a tarifa usada. Uma amostra só prova economia se a comparação incluir as chamadas generativas que ela de fato evitou. [Telemetria atual dos pipelines](../../packages/store/src/pipeline-telemetry-store.ts)

## 5. Ordem de entrega e critérios de aceite

| Etapa | Entrega verificável |
| --- | --- |
| 1. Configuração | Rascunho persistente, busca nos catálogos, montagem assistida/manual, aplicação idempotente e atualização da lateral. Uma pessoa consegue criar e reconfigurar a empresa do exemplo com Clef desligado. |
| 2. Operação | Responsável explícito, lista e quadro, despacho reconciliável, critérios, evidências e acesso ao histórico. Liberar a retirada da aba de QA padrão depois de verificar acesso a execuções antigas e em andamento. |
| 3. Decisões em paralelo | Instrumentar a referência, implementar o adaptador e as preferências independentes. Testar com falhas de rede e comparar sugestões em Company e chat separadamente. |
| 4. Sugestões optativas | Habilitar cada caso de uso que passar no ensaio abaixo. Um resultado ruim em chat mantém apenas esse caso desligado. A criação de empresas e o controle de tarefas podem ser entregues antes. |

### Testes de ponta a ponta previstos

| Caso | Ação e resultado observável |
| --- | --- |
| Empresa com dois projetos | Conversar, comparar os projetos, fixar ChatGPT e um esforço suportado, trocar uma skill, reabrir o rascunho e aplicar. A empresa aparece na lateral imediatamente com os vínculos, os dois cartões independentes e o cartão de revisão bloqueado. Contador de agentes iniciados pela criação igual a zero. |
| Catálogo e concorrência | Dois provedores oferecem modelos de nome semelhante. Desabilitar o escolhido entre proposta e aplicação exige resolver o campo. Editar uma skill em outra janela durante a geração preserva a revisão mais recente e exibe o conflito. |
| Falha durante a criação | Injetar interrupção após gravar a raiz e após criar o primeiro cartão. Reiniciar e repetir a aplicação. Conferir exatamente uma empresa, um cartão por ID de origem e todas as dependências esperadas. |
| Reconfiguração de empresa em uso | Alterar uma skill e o responsável proposto enquanto uma sessão executa. O resumo detalha quem receberá a mudança. Conferir a nova revisão numa sessão nova, a revisão anterior na execução ativa e a adoção explícita por uma sessão inativa. |
| Controle de execução | Arraste, ferramenta do agente e agendador tentam avançar o mesmo cartão bloqueado. Os três mostram o mesmo impedimento. Ao liberá-lo, disputar o despacho em duas sessões filhas produz uma reserva ativa. Interromper o worker mostra como conciliar. Repetir, revisar e reabrir preserva o histórico. |
| QA atual e legado | Abrir uma empresa sem trabalho visual, uma com plano visual ativo e uma cópia com artefatos antigos sem cartão. Localizar os resultados pelos links antigos e pela nova navegação. Confirmar o aceite da tarefa de API por evidência de teste sem abrir navegador. |
| Clef nas duas superfícies | Cobrir empresa ligada/chat desligado, o inverso, ambos desligados e avaliação paralela. Contar chamadas em transporte instrumentado. Simular resposta tardia, ambígua, credencial rejeitada e cota excedida. Enviar e retomar um chat durante a indisponibilidade, validar primeira resposta pelo provedor escolhido e conferir a identidade do modelo e o esforço usados. |

**Usabilidade da empresa e do quadro.** Comparar o formulário atual e a criação assistida com o mesmo roteiro de dois projetos. Medir tempo até a configuração aprovada, escolhas incorretas ainda presentes na revisão e correções manuais. Em janelas estreitas e largas, cronometrar quanto a pessoa leva para identificar o responsável, encontrar a dependência aberta e chegar à evidência de conclusão. Registrar a referência antes de liberar a nova interface.

**Ensaio para promover o Clef.** Preparar inicialmente pelo menos 100 casos rotulados por superfície, incluindo casos ambíguos e “nenhum candidato”. Permitir múltiplos papéis corretos quando forem intercambiáveis. Separar os dados de calibração dos de avaliação por projeto ou família de tarefa. Repetir a mesma entrada e o mesmo catálogo com a referência atual e com Flash. Em modo paralelo, comparar a previsão oculta com a escolha efetivamente feita pela pessoa. Em modo de sugestão, medir aceitação e correção diretamente.

**Critérios de promoção.** Entre as sugestões exibidas, atingir pelo menos 90% de acerto com cobertura de pelo menos 50% dos casos elegíveis. Exigir ganho de pelo menos cinco pontos percentuais de acerto sobre a referência com cobertura equivalente, ou redução de custo por decisão correta com qualidade equivalente. Medir p50/p95 de latência e tempo até o primeiro texto, alternando as variantes sob o mesmo transporte e carga. A diferença de p95 do primeiro texto deve ficar dentro de 100 ms e o teste com Cloudflare indisponível deve permitir todos os envios. Publicar amostra, incerteza, chamadas evitadas, tokens e custo. Se a diferença for inconclusiva, manter o caso em avaliação.

## 6. Implementação e medições na branch

Em **Agentes → Criar com IA**, o rascunho permite selecionar projetos, montar a equipe e revisar o primeiro lote de tarefas. Modelos, esforços e skills são validados no catálogo da instalação. A escolha do modelo da conversa de configuração é independente do coordenador. A criação grava uma empresa ociosa. Nas empresas existentes, **Ajustar com IA** permite preparar um rascunho durante o trabalho. Para aplicar a configuração, a sessão principal precisa estar inativa. Sessões filhas podem continuar executando com a revisão anterior. Em **Configurações → Modelos & IA → Decisões com Clef**, o administrador escolhe o provedor e o limite diário. [Configurador](../../apps/dashboard/features/agents/design/CompanyDesigner.tsx) · [Aplicação e recuperação](../../apps/http-api/server/routes/company/design-drafts.ts)

A validação final passou em 196 testes de 24 suítes, 8 execuções de teste no Chromium, na verificação de tipos e na compilação de produção do painel. O painel foi exercitado em 1280×720 e 1920×1080.

Os testes com armazenamento em diretórios temporários interromperam a gravação depois da raiz e do primeiro cartão. Repetir o pedido recuperou a mesma empresa e os três cartões com suas dependências. O ensaio de navegador abriu o rascunho pela Central, aceitou uma proposta sintética com dois projetos, fixou ChatGPT com esforço máximo para o revisor e conferiu os campos gravados. A regressão cobre também a gravação de template em SQLite, o bloqueio por evidência, as reservas de despacho e a revisão de configuração de sessões filhas. [Integração do rascunho](../../apps/http-api/server/routes/company/__tests__/company-designer.integration.test.ts) · [Testes Chromium](../../apps/dashboard/e2e/company-designer.spec.ts)

Um agente com acesso de leitura pode entregar o resultado por `post_to_board` e anexar uma referência para cada critério do seu cartão. O revisor consegue conferir os resultados antes de concluir a tarefa. O teste também tenta escrever no cartão de outro agente e num critério que já mudou. [Teste de evidências do agente](../../packages/company/src/services/__tests__/KanbanService.dependency-gate.test.ts)

O ensaio local usou 220 descrições sintéticas em cinco famílias de tarefas, com 20 exemplos ambíguos em cada superfície. O recomendador de papéis usou Granite multilíngue via DirectML. O chat usou o classificador local de intenção. A latência na tabela mede a decisão local para cada entrada. O tempo até a primeira resposta de chat é uma medida distinta. [Benchmark reproduzível](../../src/benchmarks/company-decisions.ts)

| Superfície | Casos | Acertos da referência | Latência p50 | Latência p95 |
| --- | ---: | ---: | ---: | ---: |
| Papel de empresa | 100 | 61 (61%) | 79,76 ms | 112,02 ms |
| Perfil do chat | 120 | 50 (41,7%) | 0,0044 ms | 0,0241 ms |

### Resultado do ensaio real com Clef Flash

A Cloudflare respondeu às 220 chamadas de inferência do conjunto sintético. Cada exemplo gerou uma consulta. O ensaio aguardou até 15 s para distinguir abstenção de atraso e contou separadamente as respostas que caberiam no orçamento de 800 ms, incluindo a classificação local. A tabela usa esse orçamento. O acerto é calculado entre as sugestões que seriam exibidas. A referência local foi avaliada nesses mesmos casos. [Medições do ensaio](../research/empresa-clef-2026-11-23.json)

| Decisão | Sugestões no prazo | Acerto do Clef | Acerto local nos mesmos casos | Latência remota p50 / p95 | Disponibilidade inicial |
| --- | ---: | ---: | ---: | ---: | --- |
| Responsável de empresa | 64/100 (64%) | 64/64 (100%) | 48/64 (75%) | 239 / 397 ms | Sugestão optativa disponível |
| Perfil do chat | 41/120 (34,2%) | 40/41 (97,6%) | 6/41 (14,6%) | 243 / 379 ms | Avaliação em paralelo |

A integração começa desligada. Em uma instalação que a habilita, Company pode oferecer a sugestão a pedido da pessoa. No chat, a cobertura ficou abaixo dos 50% exigidos. A partir de 100 casos distintos rotulados na própria instalação, o resultado local passa a determinar, por superfície, a liberação ou o retorno à avaliação. O IPC, o envio ao provedor escolhido e a abertura de agentes seguem independentes dessa decisão. [Adaptador](../../apps/http-api/server/clef-decisions.ts) · [Critérios de promoção](../../apps/http-api/server/clef-evaluation.ts)

A Cloudflare informou 67.983 tokens de entrada. Ao preço de lista de US$ 0,038 por milhão, o custo estimado é US$ 0,002583354 frente ao teto autorizado de US$ 0,10. Não foi apurada economia de chamadas generativas. Os limiares eram 0,80 de probabilidade e 0,15 de margem. O intervalo de Wilson de 95% do acerto condicional foi de 94,3–100% em Company e 87,4–99,6% no chat. As cinco famílias reutilizam estruturas de frases, o que limita a extrapolação para projetos reais. [Tarifa do Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) · [Contagens por superfície](../research/empresa-clef-2026-11-23.json)

**Primeiro texto no chat.** No Chromium, medimos do clique em Enviar até o primeiro texto no DOM, usando o mesmo provedor SSE simulado. Alternamos a ordem das variantes e descartamos dois aquecimentos por variante. Em 20 envios por condição, o p95 em 1280×720 foi 22,8 ms com Clef desligado e 22,0 ms com a decisão pendente. Em 1920×1080 foi 23,7 ms e 23,8 ms, respectivamente. Os 80 envios medidos receberam texto. A qualidade da conversa de configuração com um modelo generativo real e o tempo de uso por pessoas seguem sem medição. [Teste de navegador](../../apps/dashboard/e2e/company-designer.spec.ts)

Para reproduzir a referência, execute `pnpm exec tsx src/benchmarks/company-decisions.ts`. Para repetir a comparação com sua própria conta, configure `CLOUDFLARE_ACCOUNT_ID` e `CLOUDFLARE_API_TOKEN` no ambiente e acrescente `--live --max-usd=0.10`. A opção `--budget-file=<caminho>` conserva o teto entre tentativas. O ensaio reserva o custo máximo de contexto antes de cada chamada e desconta a diferença após receber o uso informado.

**Reversão.** Desabilitar cada integração por configuração. Manter o formulário manual, a leitura de cartões antigos e os links de QA. A retirada da aba principal é reversível. O marco de sucesso da primeira entrega é criar a equipe, executar uma tarefa com o responsável escolhido e encontrar sua evidência, inclusive em uma instalação sem Clef.

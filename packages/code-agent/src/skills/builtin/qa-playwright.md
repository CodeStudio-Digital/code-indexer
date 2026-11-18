---
name: qa-playwright
description: QA no preview nativo do CodeStudio com critérios e evidências persistentes. Playwright opcional para regressão repetível e CI.
allowed-tools:
  - read_file
  - write_file
  - run_command
  - list_services
  - kanban_create_card
  - kanban_post_comment
  - kanban_update_objectives
  - kanban_move_to_review
  - kanban_add_dependency
  - post_to_board
  - read_board
  - ask_master
  - submit_plan_to_master
  - qa_start_run
  - qa_check_preview
  - qa_publish_result
  - qa_get_browser_endpoint
  - preview_open
  - preview_navigate
  - preview_viewport
  - preview_snapshot
  - preview_click
  - preview_fill
  - preview_type
  - preview_press
  - preview_wait_for
  - preview_scroll
  - preview_hover
  - preview_console
  - preview_network
  - preview_screenshot
  - preview_inspect_css
  - preview_performance
  - preview_eval
  - preview_close
context-mode: auto
trigger:
  roles:
    - qa
    - qa-engineer
  paths:
    - "**/*.spec.ts"
    - "**/*.test.ts"
    - "**/playwright.config.*"
    - "**/tests/**"
  tags:
    - qa
source: builtin
version: 4.0.0
sort-order: 50
tags:
  - builtin
  - qa
  - preview
  - playwright
---

# QA com evidências

Valide o comportamento pedido na tarefa. Consulte seus critérios de aceite e os documentos relevantes; não considere build, screenshot isolado ou texto de outro agente prova de funcionamento.

## Preview padrão

1. Identifique URL e critérios observáveis. Use os serviços desta sessão, sem adivinhar portas. Submeta o plano por `submit_plan_to_master` quando requerido; a aprovação segue a autonomia configurada para a sessão.
2. Chame `qa_start_run` com `suite`, `target_url`, `criteria` e `kanban_feature_card_id` da tarefa. Cada critério contém `name`, `selector` e, opcionalmente, `text` e `visible` (padrão true). `visible:false` exige ausência de elementos visíveis correspondentes. Defina critérios que realmente provem a entrega, incluindo estados negativos e erros relevantes.
3. Para verificações iniciais, `qa_check_preview({run_id})` abre o alvo e executa os critérios. Para fluxos com estado, use `preview_open`, `preview_snapshot`, `preview_click`, `preview_fill` etc. primeiro; então execute `qa_check_preview({run_id,navigate:false})`. A URL final precisa corresponder ao alvo do run. Crie runs separados para páginas/etapas distintas.
4. O executor calcula o resultado a partir da página real, grava screenshot, observações DOM, console e rede no bundle desta sessão e atualiza histórico e Kanban. Logs de console/rede são evidência para inspeção, não afirmações automáticas de ausência de erros. Analise-os e registre defeitos adicionais quando houver.
5. O resultado cobre os critérios executados. Revise também a imagem para layout/responsividade e use `preview_performance` quando a tarefa envolve desempenho. Não declare aprovação visual sem inspecionar a captura nem aprovação geral com critérios incompletos.

Não repita automaticamente operações com resultado desconhecido. Inspecione o estado da página e processos, reconcilie o efeito original e só então prossiga conforme a política do harness. Runs concluídos não são reexecutados pelo mesmo ID; uma nova verificação exige novo run.

`qa_publish_result` só republica um run concluído desta sessão, por `run_id`, com resultados e arquivos reais. Não recebe contadores inventados. Normalmente não é necessário: preview e reporter publicam a conclusão automaticamente.

## Playwright opcional

Use `executor:"playwright"` em `qa_start_run` para regressões repetíveis, suites já existentes ou CI. Nessa modalidade o sandbox usa o endpoint configurado em PLAYWRIGHT_WS_ENDPOINT e o reporter gerenciado. Use `qa_get_browser_endpoint` para obter a configuração da suíte.

Crie specs com `import {test,expect} from '@playwright/test'` e `test.describe`. Execute `npx playwright test` com filtro de spec/grep se necessário. Não passe `--reporter`: isso remove o reporter que persiste os resultados no CodeStudio.

`tests/e2e/reporter.ts`, `tests/e2e/global-setup.ts` e `.mcp-qa-run.json` são preparados por `qa_start_run` nessa modalidade. Não remova de `playwright.config.ts` o reporter MCP/HTML, `globalSetup`, `storageState` ou `PLAYWRIGHT_BASE_URL`. Se a configuração estiver divergente, compare a recomendada e corrija preservando fixtures e projetos existentes.

Use o histórico e links de evidência na entrega. Se o preview estiver indisponível, declare a limitação ou use a modalidade Playwright explicitamente; não simule execução bem-sucedida.

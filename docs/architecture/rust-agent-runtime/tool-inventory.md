# Inventário completo de ferramentas do harness

Gerado por `node scripts/inventory-harness-tools.mjs --markdown`. Validar alterações com `--check --markdown`.

Catálogo próprio: **247 nomes**, incluindo aliases e ferramentas condicionais a papéis. **162 habilitados em Rust de desenvolvimento; 85 pendentes de integração nativa.**

Destes, 161 pertencem ao catálogo de entrada e 1 são exclusivos de agentes filhos autorizados.

Habilitada não significa certificada em produção. O runtime padrão permanece legado. As pendentes já existem no produto; não são funcionalidades ausentes da instalação atual.

Este arquivo mede cobertura de catálogo, não cobertura de testes nem implementação de melhorias. O acompanhamento de melhorias e os limites de validação estão em [tool-improvements.md](./tool-improvements.md).

## coder (127)

| Ferramenta | Rust | Definição |
|---|---|---|
| `api_get_request` | Desenvolvimento | [packages/code-agent/src/tools/api-client/query.ts:46](../../../packages/code-agent/src/tools/api-client/query.ts#L46) |
| `api_import_openapi` | Desenvolvimento | [packages/code-agent/src/tools/api-client/mutate.ts:13](../../../packages/code-agent/src/tools/api-client/mutate.ts#L13) |
| `api_list_requests` | Desenvolvimento | [packages/code-agent/src/tools/api-client/query.ts:10](../../../packages/code-agent/src/tools/api-client/query.ts#L10) |
| `api_mark_verified` | Desenvolvimento | [packages/code-agent/src/tools/api-client/mutate.ts:92](../../../packages/code-agent/src/tools/api-client/mutate.ts#L92) |
| `api_run_collection` | Desenvolvimento | [packages/code-agent/src/tools/api-client/run.ts:119](../../../packages/code-agent/src/tools/api-client/run.ts#L119) |
| `api_run_request` | Desenvolvimento | [packages/code-agent/src/tools/api-client/run.ts:18](../../../packages/code-agent/src/tools/api-client/run.ts#L18) |
| `api_update_request` | Desenvolvimento | [packages/code-agent/src/tools/api-client/mutate.ts:47](../../../packages/code-agent/src/tools/api-client/mutate.ts#L47) |
| `apply_patch` | Desenvolvimento | [packages/code-agent/src/tools/apply-patch.ts:525](../../../packages/code-agent/src/tools/apply-patch.ts#L525) |
| `archive_task_list` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:755](../../../packages/code-agent/src/tools/tasks.ts#L755) |
| `ask_user` | Desenvolvimento | [packages/code-agent/src/tools/interaction.ts:53](../../../packages/code-agent/src/tools/interaction.ts#L53) |
| `browser_click` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:68](../../../packages/code-agent/src/tools/browser/tools.ts#L68) |
| `browser_close` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:125](../../../packages/code-agent/src/tools/browser/tools.ts#L125) |
| `browser_extract` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:53](../../../packages/code-agent/src/tools/browser/tools.ts#L53) |
| `browser_fill` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:78](../../../packages/code-agent/src/tools/browser/tools.ts#L78) |
| `browser_open` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:24](../../../packages/code-agent/src/tools/browser/tools.ts#L24) |
| `browser_press` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:93](../../../packages/code-agent/src/tools/browser/tools.ts#L93) |
| `browser_screenshot` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:108](../../../packages/code-agent/src/tools/browser/tools.ts#L108) |
| `browser_snapshot` | Desenvolvimento | [packages/code-agent/src/tools/browser/tools.ts:39](../../../packages/code-agent/src/tools/browser/tools.ts#L39) |
| `cancel_tasks` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:620](../../../packages/code-agent/src/tools/tasks.ts#L620) |
| `capability_catalog` | Desenvolvimento | [packages/code-agent/src/tools/capability-catalog-tool.ts:104](../../../packages/code-agent/src/tools/capability-catalog-tool.ts#L104) |
| `code_exec` | Desenvolvimento | [packages/code-agent/src/tools/code-exec.ts:293](../../../packages/code-agent/src/tools/code-exec.ts#L293) |
| `collect_agents` | Desenvolvimento | [packages/code-agent/src/tools/collect-agents.ts:101](../../../packages/code-agent/src/tools/collect-agents.ts#L101) |
| `create_file` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:178](../../../packages/code-agent/src/tools/fs.ts#L178) |
| `create_goal` | Desenvolvimento | [packages/code-agent/src/tools/goal.ts:125](../../../packages/code-agent/src/tools/goal.ts#L125) |
| `create_skill` | Desenvolvimento | [packages/code-agent/src/tools/create-skill.ts:44](../../../packages/code-agent/src/tools/create-skill.ts#L44) |
| `db_command` | Desenvolvimento | [packages/code-agent/src/tools/db/tools.ts:333](../../../packages/code-agent/src/tools/db/tools.ts#L333) |
| `db_list` | Desenvolvimento | [packages/code-agent/src/tools/db/tools.ts:164](../../../packages/code-agent/src/tools/db/tools.ts#L164) |
| `db_query` | Desenvolvimento | [packages/code-agent/src/tools/db/tools.ts:241](../../../packages/code-agent/src/tools/db/tools.ts#L241) |
| `db_schema` | Desenvolvimento | [packages/code-agent/src/tools/db/tools.ts:193](../../../packages/code-agent/src/tools/db/tools.ts#L193) |
| `decision_gate` | Desenvolvimento | [packages/code-agent/src/tools/interaction.ts:280](../../../packages/code-agent/src/tools/interaction.ts#L280) |
| `delete_tasks` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:690](../../../packages/code-agent/src/tools/tasks.ts#L690) |
| `diagram_create` | Desenvolvimento | [packages/code-agent/src/tools/diagram/mutate.ts:18](../../../packages/code-agent/src/tools/diagram/mutate.ts#L18) |
| `diagram_export` | Desenvolvimento | [packages/code-agent/src/tools/diagram/export.ts:10](../../../packages/code-agent/src/tools/diagram/export.ts#L10) |
| `diagram_list` | Desenvolvimento | [packages/code-agent/src/tools/diagram/query.ts:50](../../../packages/code-agent/src/tools/diagram/query.ts#L50) |
| `diagram_read` | Desenvolvimento | [packages/code-agent/src/tools/diagram/query.ts:15](../../../packages/code-agent/src/tools/diagram/query.ts#L15) |
| `diagram_update` | Desenvolvimento | [packages/code-agent/src/tools/diagram/mutate.ts:60](../../../packages/code-agent/src/tools/diagram/mutate.ts#L60) |
| `docs_deep_research` | Desenvolvimento | [packages/docs-agent/src/bridges/docs-bridge.ts:96](../../../packages/docs-agent/src/bridges/docs-bridge.ts#L96) |
| `edit_file` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:392](../../../packages/code-agent/src/tools/fs.ts#L392) |
| `enter_worktree` | Desenvolvimento | [packages/code-agent/src/tools/worktree.ts:30](../../../packages/code-agent/src/tools/worktree.ts#L30) |
| `exec_command` | Desenvolvimento | [packages/code-agent/src/tools/exec-command.ts:540](../../../packages/code-agent/src/tools/exec-command.ts#L540) |
| `execute_tasks` | Desenvolvimento | [packages/code-agent/src/tools/execute-tasks.ts:333](../../../packages/code-agent/src/tools/execute-tasks.ts#L333) |
| `exit_worktree` | Desenvolvimento | [packages/code-agent/src/tools/worktree.ts:96](../../../packages/code-agent/src/tools/worktree.ts#L96) |
| `expand_toolset` | Desenvolvimento | [packages/code-agent/src/tools/expand.ts:95](../../../packages/code-agent/src/tools/expand.ts#L95) |
| `find_tools` | Desenvolvimento | [packages/code-agent/src/tools/find-tools.ts:57](../../../packages/code-agent/src/tools/find-tools.ts#L57) |
| `followup_task` | Desenvolvimento | [packages/code-agent/src/tools/followup-task.ts:41](../../../packages/code-agent/src/tools/followup-task.ts#L41) |
| `forget_memory` | Desenvolvimento | [packages/code-agent/src/tools/project-memory-tools.ts:226](../../../packages/code-agent/src/tools/project-memory-tools.ts#L226) |
| `get_diagnostics` | Desenvolvimento | [packages/code-agent/src/tools/diagnostics.ts:39](../../../packages/code-agent/src/tools/diagnostics.ts#L39) |
| `get_goal` | Desenvolvimento | [packages/code-agent/src/tools/goal.ts:209](../../../packages/code-agent/src/tools/goal.ts#L209) |
| `get_tool_output` | Desenvolvimento | [packages/code-agent/src/tools/tool-output.ts:26](../../../packages/code-agent/src/tools/tool-output.ts#L26) |
| `git_add` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:97](../../../packages/code-agent/src/tools/git.ts#L97) |
| `git_branch` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:137](../../../packages/code-agent/src/tools/git.ts#L137) |
| `git_commit` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:117](../../../packages/code-agent/src/tools/git.ts#L117) |
| `git_diff` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:57](../../../packages/code-agent/src/tools/git.ts#L57) |
| `git_log` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:79](../../../packages/code-agent/src/tools/git.ts#L79) |
| `git_status` | Desenvolvimento | [packages/code-agent/src/tools/git.ts:47](../../../packages/code-agent/src/tools/git.ts#L47) |
| `glob` | Desenvolvimento | [packages/code-agent/src/tools/glob.ts:55](../../../packages/code-agent/src/tools/glob.ts#L55) |
| `http_request` | Desenvolvimento | [packages/code-agent/src/tools/http.ts:43](../../../packages/code-agent/src/tools/http.ts#L43) |
| `list_agents` | Desenvolvimento | [packages/code-agent/src/tools/list-agents.ts:91](../../../packages/code-agent/src/tools/list-agents.ts#L91) |
| `list_directory` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:643](../../../packages/code-agent/src/tools/fs.ts#L643) |
| `list_notes` | Desenvolvimento | [packages/code-agent/src/tools/session-drive-tools.ts:188](../../../packages/code-agent/src/tools/session-drive-tools.ts#L188) |
| `list_sessions` | Desenvolvimento | [packages/code-agent/src/tools/exec-command.ts:738](../../../packages/code-agent/src/tools/exec-command.ts#L738) |
| `list_tasks` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:521](../../../packages/code-agent/src/tools/tasks.ts#L521) |
| `lsp_definition` | Desenvolvimento | [packages/code-agent/src/tools/lsp.ts:76](../../../packages/code-agent/src/tools/lsp.ts#L76) |
| `lsp_diagnostics` | Desenvolvimento | [packages/code-agent/src/tools/lsp.ts:235](../../../packages/code-agent/src/tools/lsp.ts#L235) |
| `lsp_hover` | Desenvolvimento | [packages/code-agent/src/tools/lsp.ts:182](../../../packages/code-agent/src/tools/lsp.ts#L182) |
| `lsp_references` | Desenvolvimento | [packages/code-agent/src/tools/lsp.ts:126](../../../packages/code-agent/src/tools/lsp.ts#L126) |
| `manage_path` | Desenvolvimento | [packages/code-agent/src/tools/manage-path.ts:202](../../../packages/code-agent/src/tools/manage-path.ts#L202) |
| `mcp_list_resources` | Desenvolvimento | [packages/code-agent/src/tools/mcp-resources.ts:34](../../../packages/code-agent/src/tools/mcp-resources.ts#L34) |
| `mcp_read_resource` | Desenvolvimento | [packages/code-agent/src/tools/mcp-resources.ts:84](../../../packages/code-agent/src/tools/mcp-resources.ts#L84) |
| `multi_edit` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:787](../../../packages/code-agent/src/tools/fs.ts#L787) |
| `preview_click` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact.ts:29](../../../packages/code-agent/src/tools/preview/interact.ts#L29) |
| `preview_close` | Desenvolvimento | [packages/code-agent/src/tools/preview/control.ts:170](../../../packages/code-agent/src/tools/preview/control.ts#L170) |
| `preview_console` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:45](../../../packages/code-agent/src/tools/preview/inspect.ts#L45) |
| `preview_double_click` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact-extra.ts:81](../../../packages/code-agent/src/tools/preview/interact-extra.ts#L81) |
| `preview_eval` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:107](../../../packages/code-agent/src/tools/preview/inspect.ts#L107) |
| `preview_fill` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact.ts:48](../../../packages/code-agent/src/tools/preview/interact.ts#L48) |
| `preview_hover` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact-extra.ts:62](../../../packages/code-agent/src/tools/preview/interact-extra.ts#L62) |
| `preview_inspect_css` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:171](../../../packages/code-agent/src/tools/preview/inspect.ts#L171) |
| `preview_memory` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:202](../../../packages/code-agent/src/tools/preview/inspect.ts#L202) |
| `preview_navigate` | Desenvolvimento | [packages/code-agent/src/tools/preview/control.ts:92](../../../packages/code-agent/src/tools/preview/control.ts#L92) |
| `preview_network` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:71](../../../packages/code-agent/src/tools/preview/inspect.ts#L71) |
| `preview_open` | Desenvolvimento | [packages/code-agent/src/tools/preview/control.ts:23](../../../packages/code-agent/src/tools/preview/control.ts#L23) |
| `preview_performance` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:189](../../../packages/code-agent/src/tools/preview/inspect.ts#L189) |
| `preview_press` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact.ts:91](../../../packages/code-agent/src/tools/preview/interact.ts#L91) |
| `preview_right_click` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact-extra.ts:98](../../../packages/code-agent/src/tools/preview/interact-extra.ts#L98) |
| `preview_screenshot` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:130](../../../packages/code-agent/src/tools/preview/inspect.ts#L130) |
| `preview_scroll` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact-extra.ts:29](../../../packages/code-agent/src/tools/preview/interact-extra.ts#L29) |
| `preview_snapshot` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:232](../../../packages/code-agent/src/tools/preview/inspect.ts#L232) |
| `preview_storage` | Desenvolvimento | [packages/code-agent/src/tools/preview/inspect.ts:215](../../../packages/code-agent/src/tools/preview/inspect.ts#L215) |
| `preview_type` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact.ts:69](../../../packages/code-agent/src/tools/preview/interact.ts#L69) |
| `preview_viewport` | Desenvolvimento | [packages/code-agent/src/tools/preview/control.ts:123](../../../packages/code-agent/src/tools/preview/control.ts#L123) |
| `preview_wait_for` | Desenvolvimento | [packages/code-agent/src/tools/preview/interact.ts:125](../../../packages/code-agent/src/tools/preview/interact.ts#L125) |
| `rag_doc_outline` | Desenvolvimento | [packages/code-agent/src/tools/rag-doc-outline.ts:21](../../../packages/code-agent/src/tools/rag-doc-outline.ts#L21) |
| `rag_read_doc` | Desenvolvimento | [packages/code-agent/src/tools/rag-read-doc.ts:23](../../../packages/code-agent/src/tools/rag-read-doc.ts#L23) |
| `rag_search_docs` | Desenvolvimento | [packages/code-agent/src/tools/rag-search-docs.ts:55](../../../packages/code-agent/src/tools/rag-search-docs.ts#L55) |
| `read_agent_transcript` | Desenvolvimento | [packages/code-agent/src/tools/read-agent-transcript.ts:95](../../../packages/code-agent/src/tools/read-agent-transcript.ts#L95) |
| `read_file` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:514](../../../packages/code-agent/src/tools/fs.ts#L514) |
| `read_plan` | Desenvolvimento | [packages/code-agent/src/tools/session-drive-tools.ts:36](../../../packages/code-agent/src/tools/session-drive-tools.ts#L36) |
| `recall_conversation` | Desenvolvimento | [packages/code-agent/src/tools/conversation-chapters.ts:62](../../../packages/code-agent/src/tools/conversation-chapters.ts#L62) |
| `recall_investigations` | Desenvolvimento | [packages/code-agent/src/tools/session-drive-tools.ts:234](../../../packages/code-agent/src/tools/session-drive-tools.ts#L234) |
| `recall_memory` | Desenvolvimento | [packages/code-agent/src/tools/project-memory-tools.ts:141](../../../packages/code-agent/src/tools/project-memory-tools.ts#L141) |
| `record_memo` | Desenvolvimento (somente filho) | [packages/code-agent/src/tools/record-memo.ts:58](../../../packages/code-agent/src/tools/record-memo.ts#L58) |
| `remember` | Desenvolvimento | [packages/code-agent/src/tools/project-memory-tools.ts:48](../../../packages/code-agent/src/tools/project-memory-tools.ts#L48) |
| `request_review` | Desenvolvimento | [packages/code-agent/src/tools/request-review.ts:34](../../../packages/code-agent/src/tools/request-review.ts#L34) |
| `resume_agent` | Desenvolvimento | [packages/code-agent/src/tools/resume-agent.ts:50](../../../packages/code-agent/src/tools/resume-agent.ts#L50) |
| `run_command` | Desenvolvimento | [packages/code-agent/src/tools/shell.ts:147](../../../packages/code-agent/src/tools/shell.ts#L147) |
| `save_note` | Desenvolvimento | [packages/code-agent/src/tools/session-drive-tools.ts:77](../../../packages/code-agent/src/tools/session-drive-tools.ts#L77) |
| `self_review` | Desenvolvimento | [packages/code-agent/src/tools/self-review.ts:63](../../../packages/code-agent/src/tools/self-review.ts#L63) |
| `send_input` | Desenvolvimento | [packages/code-agent/src/tools/send-input.ts:48](../../../packages/code-agent/src/tools/send-input.ts#L48) |
| `send_message` | Desenvolvimento | [packages/code-agent/src/tools/send-message.ts:42](../../../packages/code-agent/src/tools/send-message.ts#L42) |
| `spawn_agent` | Desenvolvimento | [packages/code-agent/src/tools/spawn-agent.ts:788](../../../packages/code-agent/src/tools/spawn-agent.ts#L788) |
| `submit_plan` | Desenvolvimento | [packages/code-agent/src/tools/plan.ts:74](../../../packages/code-agent/src/tools/plan.ts#L74) |
| `submit_spec` | Desenvolvimento | [packages/code-agent/src/tools/spec/submit-spec.ts:22](../../../packages/code-agent/src/tools/spec/submit-spec.ts#L22) |
| `submit_tasks` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:403](../../../packages/code-agent/src/tools/tasks.ts#L403) |
| `task_complete` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:807](../../../packages/code-agent/src/tools/tasks.ts#L807) |
| `task_list` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:1114](../../../packages/code-agent/src/tools/tasks.ts#L1114) |
| `todo_write` | Desenvolvimento | [packages/code-agent/src/tools/todo.ts:166](../../../packages/code-agent/src/tools/todo.ts#L166) |
| `update_goal` | Desenvolvimento | [packages/code-agent/src/tools/goal.ts:254](../../../packages/code-agent/src/tools/goal.ts#L254) |
| `update_task` | Desenvolvimento | [packages/code-agent/src/tools/tasks.ts:944](../../../packages/code-agent/src/tools/tasks.ts#L944) |
| `update_todo` | Desenvolvimento | [packages/code-agent/src/tools/todo.ts:318](../../../packages/code-agent/src/tools/todo.ts#L318) |
| `view_image` | Desenvolvimento | [packages/code-agent/src/tools/view-image.ts:31](../../../packages/code-agent/src/tools/view-image.ts#L31) |
| `wait_agents` | Desenvolvimento | [packages/code-agent/src/tools/wait-agents.ts:101](../../../packages/code-agent/src/tools/wait-agents.ts#L101) |
| `web_fetch` | Desenvolvimento | [packages/code-agent/src/tools/web.ts:30](../../../packages/code-agent/src/tools/web.ts#L30) |
| `web_search` | Desenvolvimento | [packages/code-agent/src/tools/web.ts:90](../../../packages/code-agent/src/tools/web.ts#L90) |
| `workflow` | Desenvolvimento | [packages/code-agent/src/tools/workflow/workflow-tool.ts:178](../../../packages/code-agent/src/tools/workflow/workflow-tool.ts#L178) |
| `write_file` | Desenvolvimento | [packages/code-agent/src/tools/fs.ts:138](../../../packages/code-agent/src/tools/fs.ts#L138) |
| `write_stdin` | Desenvolvimento | [packages/code-agent/src/tools/exec-command.ts:770](../../../packages/code-agent/src/tools/exec-command.ts#L770) |

## company (77)

| Ferramenta | Rust | Definição |
|---|---|---|
| `abort_subordinate_agent` | Pendente | [packages/company/src/tools/master-tools.ts:534](../../../packages/company/src/tools/master-tools.ts#L534) |
| `answer_subordinate_question` | Pendente | [packages/company/src/tools/master-tools.ts:446](../../../packages/company/src/tools/master-tools.ts#L446) |
| `app_dispatch_ready_work` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:301](../../../packages/company/src/tools/app-studio/app-workflow.ts#L301) |
| `app_get_db_state` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:404](../../../packages/company/src/tools/app-studio/app-workflow.ts#L404) |
| `app_get_plan` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:125](../../../packages/company/src/tools/app-studio/app-workflow.ts#L125) |
| `app_get_state` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:91](../../../packages/company/src/tools/app-studio/app-workflow.ts#L91) |
| `app_record_work_evidence` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:324](../../../packages/company/src/tools/app-studio/app-workflow.ts#L324) |
| `app_request_decision` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:244](../../../packages/company/src/tools/app-studio/app-workflow.ts#L244) |
| `app_request_plan_approval` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:283](../../../packages/company/src/tools/app-studio/app-workflow.ts#L283) |
| `app_run_checks` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:489](../../../packages/company/src/tools/app-studio/app-workflow.ts#L489) |
| `app_update_database` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:426](../../../packages/company/src/tools/app-studio/app-workflow.ts#L426) |
| `app_update_plan` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:152](../../../packages/company/src/tools/app-studio/app-workflow.ts#L152) |
| `app_upsert_work_items` | Pendente | [packages/company/src/tools/app-studio/app-workflow.ts:196](../../../packages/company/src/tools/app-studio/app-workflow.ts#L196) |
| `append_shared_file` | Pendente | [packages/company/src/tools/shared-drive-tools.ts:99](../../../packages/company/src/tools/shared-drive-tools.ts#L99) |
| `approve_subordinate_plan` | Pendente | [packages/company/src/tools/master-tools.ts:407](../../../packages/company/src/tools/master-tools.ts#L407) |
| `approve_subordinate_plans` | Pendente | [packages/company/src/tools/approve-subordinates-batch.ts:68](../../../packages/company/src/tools/approve-subordinates-batch.ts#L68) |
| `approve_subordinate_tasks` | Pendente | [packages/company/src/tools/master-tools.ts:492](../../../packages/company/src/tools/master-tools.ts#L492) |
| `ask_master` | Pendente | [packages/company/src/tools/subordinate-tools.ts:39](../../../packages/company/src/tools/subordinate-tools.ts#L39) |
| `broadcast_to_roles` | Pendente | [packages/company/src/tools/master-tools.ts:932](../../../packages/company/src/tools/master-tools.ts#L932) |
| `check_inbox_answer` | Pendente | [packages/company/src/tools/subordinate-tools.ts:605](../../../packages/company/src/tools/subordinate-tools.ts#L605) |
| `delete_shared_file` | Pendente | [packages/company/src/tools/shared-drive-tools.ts:192](../../../packages/company/src/tools/shared-drive-tools.ts#L192) |
| `docs_delete` | Pendente | [packages/company/src/tools/docs-tools.ts:378](../../../packages/company/src/tools/docs-tools.ts#L378) |
| `docs_index_update` | Pendente | [packages/company/src/tools/docs-tools.ts:306](../../../packages/company/src/tools/docs-tools.ts#L306) |
| `docs_list` | Pendente | [packages/company/src/tools/docs-tools.ts:275](../../../packages/company/src/tools/docs-tools.ts#L275) |
| `docs_read` | Pendente | [packages/company/src/tools/docs-tools.ts:239](../../../packages/company/src/tools/docs-tools.ts#L239) |
| `docs_write` | Pendente | [packages/company/src/tools/docs-tools.ts:188](../../../packages/company/src/tools/docs-tools.ts#L188) |
| `env_delete` | Pendente | [packages/company/src/tools/env-tools.ts:244](../../../packages/company/src/tools/env-tools.ts#L244) |
| `env_list` | Pendente | [packages/company/src/tools/env-tools.ts:56](../../../packages/company/src/tools/env-tools.ts#L56) |
| `env_read` | Pendente | [packages/company/src/tools/env-tools.ts:85](../../../packages/company/src/tools/env-tools.ts#L85) |
| `env_set` | Pendente | [packages/company/src/tools/env-tools.ts:113](../../../packages/company/src/tools/env-tools.ts#L113) |
| `env_validate` | Pendente | [packages/company/src/tools/env-tools.ts:188](../../../packages/company/src/tools/env-tools.ts#L188) |
| `finalize_subordinates` | Pendente | [packages/company/src/tools/master-tools.ts:701](../../../packages/company/src/tools/master-tools.ts#L701) |
| `forward_to_agent` | Pendente | [packages/company/src/tools/master-tools.ts:640](../../../packages/company/src/tools/master-tools.ts#L640) |
| `kanban_add_dependency` | Pendente | [packages/company/src/tools/kanban-tools.ts:279](../../../packages/company/src/tools/kanban-tools.ts#L279) |
| `kanban_assign_agent` | Pendente | [packages/company/src/tools/kanban-tools.ts:337](../../../packages/company/src/tools/kanban-tools.ts#L337) |
| `kanban_create_card` | Pendente | [packages/company/src/tools/kanban-batch.ts:111](../../../packages/company/src/tools/kanban-batch.ts#L111) |
| `kanban_get_card` | Pendente | [packages/company/src/tools/kanban-tools.ts:401](../../../packages/company/src/tools/kanban-tools.ts#L401) |
| `kanban_list_cards` | Pendente | [packages/company/src/tools/kanban-tools.ts:366](../../../packages/company/src/tools/kanban-tools.ts#L366) |
| `kanban_move_card` | Pendente | [packages/company/src/tools/kanban-batch.ts:148](../../../packages/company/src/tools/kanban-batch.ts#L148) |
| `kanban_move_to_review` | Pendente | [packages/company/src/tools/subordinate-kanban-tools.ts:58](../../../packages/company/src/tools/subordinate-kanban-tools.ts#L58) |
| `kanban_plan_graph` | Pendente | [packages/company/src/tools/kanban-plan-graph.ts:57](../../../packages/company/src/tools/kanban-plan-graph.ts#L57) |
| `kanban_post_comment` | Pendente | [packages/company/src/tools/kanban-tools.ts:129](../../../packages/company/src/tools/kanban-tools.ts#L129) |
| `kanban_read_my_card` | Pendente | [packages/company/src/tools/board-tools.ts:361](../../../packages/company/src/tools/board-tools.ts#L361) |
| `kanban_remove_dependency` | Pendente | [packages/company/src/tools/kanban-tools.ts:307](../../../packages/company/src/tools/kanban-tools.ts#L307) |
| `kanban_update_meta` | Pendente | [packages/company/src/tools/kanban-tools.ts:72](../../../packages/company/src/tools/kanban-tools.ts#L72) |
| `kanban_update_objectives` | Pendente | [packages/company/src/tools/kanban-tools.ts:212](../../../packages/company/src/tools/kanban-tools.ts#L212) |
| `list_company_projects` | Pendente | [packages/company/src/tools/master-tools.ts:603](../../../packages/company/src/tools/master-tools.ts#L603) |
| `list_containers` | Pendente | [packages/company/src/tools/master-tools.ts:813](../../../packages/company/src/tools/master-tools.ts#L813) |
| `list_services` | Pendente | [packages/company/src/tools/sandbox-tools.ts:125](../../../packages/company/src/tools/sandbox-tools.ts#L125) |
| `list_shared_files` | Pendente | [packages/company/src/tools/shared-drive-tools.ts:159](../../../packages/company/src/tools/shared-drive-tools.ts#L159) |
| `list_subordinates` | Pendente | [packages/company/src/tools/master-tools.ts:555](../../../packages/company/src/tools/master-tools.ts#L555) |
| `post_to_board` | Pendente | [packages/company/src/tools/board-tools.ts:97](../../../packages/company/src/tools/board-tools.ts#L97) |
| `qa_get_browser_endpoint` | Pendente | [packages/company/src/tools/qa/qa-get-browser-endpoint.ts:230](../../../packages/company/src/tools/qa/qa-get-browser-endpoint.ts#L230) |
| `qa_publish_result` | Pendente | [packages/company/src/tools/qa/qa-publish-result.ts:64](../../../packages/company/src/tools/qa/qa-publish-result.ts#L64) |
| `qa_start_run` | Pendente | [packages/company/src/tools/qa/qa-start-run.ts:205](../../../packages/company/src/tools/qa/qa-start-run.ts#L205) |
| `read_board` | Pendente | [packages/company/src/tools/board-tools.ts:264](../../../packages/company/src/tools/board-tools.ts#L264) |
| `read_container_logs` | Pendente | [packages/company/src/tools/master-tools.ts:1036](../../../packages/company/src/tools/master-tools.ts#L1036) |
| `read_my_inbox` | Pendente | [packages/company/src/tools/subordinate-tools.ts:535](../../../packages/company/src/tools/subordinate-tools.ts#L535) |
| `read_sandbox_logs` | Pendente | [packages/company/src/tools/sandbox-tools.ts:60](../../../packages/company/src/tools/sandbox-tools.ts#L60) |
| `read_shared_file` | Pendente | [packages/company/src/tools/shared-drive-tools.ts:129](../../../packages/company/src/tools/shared-drive-tools.ts#L129) |
| `recommend_role` | Pendente | [packages/company/src/tools/master-tools.ts:882](../../../packages/company/src/tools/master-tools.ts#L882) |
| `respond_to_inbox` | Pendente | [packages/company/src/tools/master-tools.ts:997](../../../packages/company/src/tools/master-tools.ts#L997)<br>[packages/company/src/tools/subordinate-tools.ts:505](../../../packages/company/src/tools/subordinate-tools.ts#L505) |
| `resume_subordinate` | Pendente | [packages/company/src/tools/master-tools.ts:790](../../../packages/company/src/tools/master-tools.ts#L790) |
| `review_subordinate_work` | Pendente | [packages/company/src/tools/review-subordinate.ts:64](../../../packages/company/src/tools/review-subordinate.ts#L64) |
| `send_to_agent` | Pendente | [packages/company/src/tools/subordinate-tools.ts:342](../../../packages/company/src/tools/subordinate-tools.ts#L342) |
| `send_to_master` | Pendente | [packages/company/src/tools/subordinate-tools.ts:434](../../../packages/company/src/tools/subordinate-tools.ts#L434) |
| `service_logs` | Pendente | [packages/company/src/tools/service-tools.ts:136](../../../packages/company/src/tools/service-tools.ts#L136) |
| `service_restart` | Pendente | [packages/company/src/tools/service-tools.ts:78](../../../packages/company/src/tools/service-tools.ts#L78) |
| `service_start` | Pendente | [packages/company/src/tools/service-tools.ts:78](../../../packages/company/src/tools/service-tools.ts#L78) |
| `service_stop` | Pendente | [packages/company/src/tools/service-tools.ts:78](../../../packages/company/src/tools/service-tools.ts#L78) |
| `set_agent_status` | Pendente | [packages/company/src/tools/board-tools.ts:329](../../../packages/company/src/tools/board-tools.ts#L329) |
| `spawn_subordinate_agent` | Pendente | [packages/company/src/tools/master-tools.ts:105](../../../packages/company/src/tools/master-tools.ts#L105) |
| `submit_plan_to_master` | Pendente | [packages/company/src/tools/subordinate-tools.ts:115](../../../packages/company/src/tools/subordinate-tools.ts#L115) |
| `submit_specification_to_master` | Pendente | [packages/company/src/tools/subordinate/submit-specification.ts:29](../../../packages/company/src/tools/subordinate/submit-specification.ts#L29) |
| `submit_tasks_to_master` | Pendente | [packages/company/src/tools/subordinate-tools.ts:255](../../../packages/company/src/tools/subordinate-tools.ts#L255) |
| `wait_for_subordinates` | Pendente | [packages/company/src/tools/master-tools.ts:300](../../../packages/company/src/tools/master-tools.ts#L300) |
| `write_shared_file` | Pendente | [packages/company/src/tools/shared-drive-tools.ts:69](../../../packages/company/src/tools/shared-drive-tools.ts#L69) |

## docs-agent (6)

| Ferramenta | Rust | Definição |
|---|---|---|
| `docs_finish` | Pendente | [packages/docs-agent/src/tools/docs-finish.ts:45](../../../packages/docs-agent/src/tools/docs-finish.ts#L45) |
| `docs_list_sources` | Pendente | [packages/docs-agent/src/tools/docs-list-sources.ts:20](../../../packages/docs-agent/src/tools/docs-list-sources.ts#L20) |
| `docs_plan` | Pendente | [packages/docs-agent/src/tools/docs-plan.ts:33](../../../packages/docs-agent/src/tools/docs-plan.ts#L33) |
| `docs_read_chunk` | Pendente | [packages/docs-agent/src/tools/docs-read-chunk.ts:30](../../../packages/docs-agent/src/tools/docs-read-chunk.ts#L30) |
| `docs_search` | Pendente | [packages/docs-agent/src/tools/docs-search-chunks.ts:32](../../../packages/docs-agent/src/tools/docs-search-chunks.ts#L32) |
| `docs_synthesize` | Pendente | [packages/docs-agent/src/tools/docs-synthesize.ts:40](../../../packages/docs-agent/src/tools/docs-synthesize.ts#L40) |

## mcp-internal (33)

| Ferramenta | Rust | Definição |
|---|---|---|
| `mcp__cancel_agent_run` | Pendente | [apps/mcp-server/tools/agents.ts:123](../../../apps/mcp-server/tools/agents.ts#L123) |
| `mcp__export_docs` | Desenvolvimento | [apps/mcp-server/tools/misc.ts:42](../../../apps/mcp-server/tools/misc.ts#L42) |
| `mcp__find_implementations` | Desenvolvimento | [apps/mcp-server/tools/type-relations.ts:30](../../../apps/mcp-server/tools/type-relations.ts#L30) |
| `mcp__find_references` | Desenvolvimento | [apps/mcp-server/tools/symbol-references.ts:13](../../../apps/mcp-server/tools/symbol-references.ts#L13) |
| `mcp__get_agent_result` | Desenvolvimento | [apps/mcp-server/tools/agents.ts:101](../../../apps/mcp-server/tools/agents.ts#L101) |
| `mcp__get_agent_run` | Desenvolvimento | [apps/mcp-server/tools/agents.ts:86](../../../apps/mcp-server/tools/agents.ts#L86) |
| `mcp__get_costs` | Desenvolvimento | [apps/mcp-server/tools/misc.ts:7](../../../apps/mcp-server/tools/misc.ts#L7) |
| `mcp__get_dependencies` | Desenvolvimento | [apps/mcp-server/tools/index-navigation.ts:38](../../../apps/mcp-server/tools/index-navigation.ts#L38) |
| `mcp__get_dependents` | Desenvolvimento | [apps/mcp-server/tools/index-navigation.ts:38](../../../apps/mcp-server/tools/index-navigation.ts#L38) |
| `mcp__get_file_skeleton` | Desenvolvimento | [apps/mcp-server/tools/file-skeleton.ts:11](../../../apps/mcp-server/tools/file-skeleton.ts#L11) |
| `mcp__get_hierarchy` | Desenvolvimento | [apps/mcp-server/tools/type-relations.ts:46](../../../apps/mcp-server/tools/type-relations.ts#L46) |
| `mcp__get_project_overview` | Desenvolvimento | [apps/mcp-server/tools/projects.ts:126](../../../apps/mcp-server/tools/projects.ts#L126) |
| `mcp__get_project_pulse` | Desenvolvimento | [apps/mcp-server/tools/projects.ts:196](../../../apps/mcp-server/tools/projects.ts#L196) |
| `mcp__get_recently_modified_files` | Desenvolvimento | [apps/mcp-server/tools/index-navigation.ts:23](../../../apps/mcp-server/tools/index-navigation.ts#L23) |
| `mcp__get_repo_map` | Desenvolvimento | [apps/mcp-server/tools/repo-map.ts:7](../../../apps/mcp-server/tools/repo-map.ts#L7) |
| `mcp__get_symbol_body` | Desenvolvimento | [apps/mcp-server/tools/symbol-body.ts:23](../../../apps/mcp-server/tools/symbol-body.ts#L23) |
| `mcp__grep_code` | Desenvolvimento | [apps/mcp-server/tools/search.ts:243](../../../apps/mcp-server/tools/search.ts#L243) |
| `mcp__index_project` | Desenvolvimento | [apps/mcp-server/tools/projects.ts:45](../../../apps/mcp-server/tools/projects.ts#L45) |
| `mcp__list_agent_runs` | Desenvolvimento | [apps/mcp-server/tools/agents.ts:71](../../../apps/mcp-server/tools/agents.ts#L71) |
| `mcp__list_agents` | Desenvolvimento | [apps/mcp-server/tools/agents.ts:16](../../../apps/mcp-server/tools/agents.ts#L16) |
| `mcp__list_directory` | Desenvolvimento | [apps/mcp-server/tools/list-directory.ts:7](../../../apps/mcp-server/tools/list-directory.ts#L7) |
| `mcp__list_models` | Desenvolvimento | [apps/mcp-server/tools/misc.ts:70](../../../apps/mcp-server/tools/misc.ts#L70) |
| `mcp__prepare_edit` | Desenvolvimento | [apps/mcp-server/tools/prepare-edit.ts:14](../../../apps/mcp-server/tools/prepare-edit.ts#L14) |
| `mcp__rag_doc_outline` | Desenvolvimento | [apps/mcp-server/tools/docs.ts:107](../../../apps/mcp-server/tools/docs.ts#L107) |
| `mcp__rag_read_doc` | Desenvolvimento | [apps/mcp-server/tools/docs.ts:76](../../../apps/mcp-server/tools/docs.ts#L76) |
| `mcp__rag_search_docs` | Desenvolvimento | [apps/mcp-server/tools/docs.ts:49](../../../apps/mcp-server/tools/docs.ts#L49) |
| `mcp__read_file` | Desenvolvimento | [apps/mcp-server/tools/read-file.ts:19](../../../apps/mcp-server/tools/read-file.ts#L19) |
| `mcp__save_memory` | Desenvolvimento | [apps/mcp-server/tools/snapshots.ts:18](../../../apps/mcp-server/tools/snapshots.ts#L18) |
| `mcp__search` | Desenvolvimento | [apps/mcp-server/tools/search.ts:134](../../../apps/mcp-server/tools/search.ts#L134) |
| `mcp__search_memory` | Desenvolvimento | [apps/mcp-server/tools/search-memory.ts:10](../../../apps/mcp-server/tools/search-memory.ts#L10) |
| `mcp__semantic_neighbors` | Desenvolvimento | [apps/mcp-server/tools/semantic-neighbors.ts:7](../../../apps/mcp-server/tools/semantic-neighbors.ts#L7) |
| `mcp__start_agent_run` | Pendente | [apps/mcp-server/tools/agents.ts:26](../../../apps/mcp-server/tools/agents.ts#L26) |
| `mcp__trace_usage` | Desenvolvimento | [apps/mcp-server/tools/usage-trace.ts:8](../../../apps/mcp-server/tools/usage-trace.ts#L8) |

## skills (4)

| Ferramenta | Rust | Definição |
|---|---|---|
| `get_skill_content` | Desenvolvimento | [packages/code-agent/src/skills/skill-tool-builder.ts:164](../../../packages/code-agent/src/skills/skill-tool-builder.ts#L164) |
| `get_skills_list` | Desenvolvimento | [packages/code-agent/src/skills/skill-tool-builder.ts:93](../../../packages/code-agent/src/skills/skill-tool-builder.ts#L93) |
| `invoke_skill` | Desenvolvimento | [packages/code-agent/src/skills/skill-tool-builder.ts:243](../../../packages/code-agent/src/skills/skill-tool-builder.ts#L243) |
| `list_skill_namespaces` | Desenvolvimento | [packages/code-agent/src/skills/skill-tool-builder.ts:52](../../../packages/code-agent/src/skills/skill-tool-builder.ts#L52) |

## Catálogos dinâmicos

MCP externo e plugins dependem do que está conectado e permitido em cada sessão. Seus nomes não cabem numa contagem fixa. O inventário registra as fábricas abaixo sem consultar credenciais ou carregar ferramentas externas.

| Superfície | Fábrica | Fonte |
|---|---|---|
| coder | name | packages/code-agent/src/tools/mcp-bridge.ts:227 |
| coder | `mcp__${t.name}` | packages/code-agent/src/tools/mcp-bridge.ts:283 |
| coder | prefixedName | packages/code-agent/src/tools/mcp-server-manager.ts:348 |
| plugin | `plugin__${plugin.namespace}__${decl.name}` | packages/plugin-host/src/plugin-tool-bridge.ts:70 |
| external-mcp | t.name | apps/http-api/workers/RemoteMcpServerManager.ts:99 |

A fachada MCP pública já pode encaminhar runs ao runtime selecionado. Isso não habilita automaticamente `mcp__start_agent_run` como ferramenta aninhada de uma árvore Rust.

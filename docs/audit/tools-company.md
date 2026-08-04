# Tabela — company (63 tools extraídas estaticamente)

> Snapshot 2026-07-01 · rubrica e flags: [TOOL_AUDIT.md](TOOL_AUDIT.md)
> Caveat: tools company só existem em sessões company/builder — ZERO-CALL reflete quantas sessões company rodaram na janela, não a qualidade da tool. Descrições passam pelo terse da assembly (bootstrap/modelo compacto): terse-safety verificada mecanicamente em 2026-07-01 (2 violações corrigidas: set_agent_status, ds_docs; +docs_index_update, env_delete nas estáticas).
> Tools de master (spawn_subordinate_agent etc.) constroem descrição via factory com contexto — auditadas por leitura; estilo geral D1-D2 (frases-guia com fluxo de aprovação documentado).

| tool | grupo | arquivo | calls | err% | len | U | D | flags |
|---|---|---|---|---|---|---|---|---|
| abort_subordinate_agent | master | master-tools.ts | 0 | 0 | 114 | U0 | D1 | ZERO-CALL |
| answer_subordinate_question | master | master-tools.ts | 0 | 0 | 237 | U0 | D2 | ZERO-CALL |
| approve_subordinate_plan | master | master-tools.ts | 0 | 0 | 171 | U0 | D2 | ZERO-CALL |
| approve_subordinate_tasks | master | master-tools.ts | 0 | 0 | 181 | U0 | D2 | ZERO-CALL |
| broadcast_to_roles | master | master-tools.ts | 0 | 0 | 458 | U0 | D2 | ZERO-CALL |
| finalize_subordinates | master | master-tools.ts | 0 | 0 | 299 | U0 | D2 | ZERO-CALL |
| forward_to_agent | master | master-tools.ts | 19 | 0 | 236 | U1 | D2 | OK |
| recommend_role | master | master-tools.ts | 0 | 0 | 355 | U0 | D2 | ZERO-CALL |
| respond_to_inbox | master | master-tools.ts | 1 | 0 | 310 | U1 | D2 | OK |
| resume_subordinate | master | master-tools.ts | 1 | 0 | 182 | U1 | D2 | OK |
| review_subordinate_work | master | review-subordinate.ts | 0 | 0 | 474 | U0 | D2 | ZERO-CALL |
| spawn_subordinate_agent | master | master-tools.ts | 4 | 0 | 498 | U1 | D2 | OK |
| wait_for_subordinates | master | master-tools.ts | 15 | 0 | 225 | U1 | D2 | OK |
| kanban_add_dependency | kanban | kanban-tools.ts | 19 | 0 | 252 | U1 | D2 | OK |
| kanban_assign_agent | kanban | kanban-tools.ts | 17 | 0 | 178 | U1 | D2 | OK |
| kanban_create_card | kanban | kanban-batch.ts | 5 | 0 | 401 | U1 | D2 | OK |
| kanban_get_card | kanban | kanban-tools.ts | 15 | 0 | 97 | U1 | D1 | OK |
| kanban_list_cards | kanban | kanban-tools.ts | 3 | 0 | 99 | U1 | D1 | OK |
| kanban_move_card | kanban | kanban-batch.ts | 33 | 9.1 | 360 | U2 | D2 | OK |
| kanban_move_to_review | kanban | subordinate-kanban-tools.ts | 2 | 100 | 179 | U1 | D2 | OK |
| kanban_post_comment | kanban | kanban-tools.ts | 15 | 0 | 306 | U1 | D2 | OK |
| kanban_remove_dependency | kanban | kanban-tools.ts | 0 | 0 | 47 | U0 | D0 | ZERO-CALL |
| kanban_update_meta | kanban | kanban-tools.ts | 0 | 0 | 177 | U0 | D2 | ZERO-CALL |
| kanban_update_objectives | kanban | kanban-tools.ts | 25 | 12 | 285 | U2 | D2 | OK |
| ask_master | subordinate | subordinate-tools.ts | 0 | 0 | 484 | U0 | D2 | ZERO-CALL |
| check_inbox_answer | subordinate | subordinate-tools.ts | 2 | 0 | 466 | U1 | D2 | OK |
| send_to_agent | subordinate | subordinate-tools.ts | 2 | 50 | 584 | U1 | D2 | OK |
| send_to_master | subordinate | subordinate-tools.ts | 0 | 0 | 923 | U0 | D2 | ZERO-CALL |
| submit_plan_to_master | subordinate | subordinate-tools.ts | 0 | 0 | 480 | U0 | D2 | ZERO-CALL |
| submit_specification_to_master | subordinate | subordinate/submit-specification.ts | 0 | 0 | 429 | U0 | D2 | ZERO-CALL |
| submit_tasks_to_master | subordinate | subordinate-tools.ts | 0 | 0 | 381 | U0 | D2 | ZERO-CALL |
| kanban_read_my_card | board | board-tools.ts | 17 | 0 | 171 | U1 | D2 | OK |
| post_to_board | board | board-tools.ts | 29 | 0 | 778 | U2 | D2 | OK |
| set_agent_status | board | board-tools.ts | 4 | 0 | 153 | U1 | D2 | OK |
| append_shared_file | drive | shared-drive-tools.ts | 0 | 0 | 135 | U0 | D1 | ZERO-CALL |
| delete_shared_file | drive | shared-drive-tools.ts | 0 | 0 | 87 | U0 | D1 | ZERO-CALL |
| read_shared_file | drive | shared-drive-tools.ts | 20 | 0 | 131 | U2 | D1 | OK |
| write_shared_file | drive | shared-drive-tools.ts | 14 | 0 | 413 | U1 | D2 | OK |
| env_delete | env | env-tools.ts | 0 | 0 | 282 | U0 | D2 | ZERO-CALL |
| env_list | env | env-tools.ts | 0 | 0 | 314 | U0 | D2 | ZERO-CALL |
| env_read | env | env-tools.ts | 0 | 0 | 238 | U0 | D2 | ZERO-CALL |
| env_set | env | env-tools.ts | 0 | 0 | 727 | U0 | D2 | ZERO-CALL |
| env_validate | env | env-tools.ts | 0 | 0 | 377 | U0 | D2 | ZERO-CALL |
| db_list | db | database-tools.ts | 0 | 0 | 384 | U0 | D2 | ZERO-CALL |
| db_query | db | database-tools.ts | 0 | 0 | 400 | U0 | D2 | ZERO-CALL |
| db_schema | db | database-tools.ts | 0 | 0 | 347 | U0 | D2 | ZERO-CALL |
| docs_delete | docs | docs-tools.ts | 0 | 0 | 225 | U0 | D2 | ZERO-CALL |
| docs_index_update | docs | docs-tools.ts | 0 | 0 | 409 | U0 | D2 | ZERO-CALL |
| docs_list | docs | docs-tools.ts | 0 | 0 | 233 | U0 | D2 | ZERO-CALL |
| docs_read | docs | docs-tools.ts | 0 | 0 | 222 | U0 | D2 | ZERO-CALL |
| docs_write | docs | docs-tools.ts | 0 | 0 | 416 | U0 | D2 | ZERO-CALL |
| qa_get_browser_endpoint | qa | qa/qa-get-browser-endpoint.ts | 0 | 0 | 384 | U0 | D2 | ZERO-CALL |
| qa_publish_result | qa | qa/qa-publish-result.ts | 0 | 0 | 135 | U0 | D1 | ZERO-CALL |
| qa_start_run | qa | qa/qa-start-run.ts | 0 | 0 | 177 | U0 | D2 | ZERO-CALL |
| ds_audit_package | ds | design-system/ds-audit-package.ts | 7 | 14.3 | 194 | U1 | D2 | OK |
| ds_component | ds | design-system/consumer-tools.ts | 13 | 30.8 | 183 | U1 | D2 | QUALITY-RISK(err 30.8%) |
| ds_components | ds | design-system/consumer-tools.ts | 2 | 0 | 252 | U1 | D2 | OK |
| ds_docs | ds | design-system/consumer-tools.ts | 3 | 0 | 197 | U1 | D2 | OK |
| ds_get_session_info | ds | design-system/ds-get-session-info.ts | 6 | 0 | 172 | U1 | D2 | OK |
| ds_list_components | ds | design-system/ds-list-components.ts | 9 | 11.1 | 182 | U1 | D2 | OK |
| ds_publish_version | ds | design-system/ds-publish-version.ts | 9 | 55.6 | 200 | U1 | D2 | QUALITY-RISK(err 55.6%) |
| ds_record_component | ds | design-system/ds-record-component.ts | 63 | 0 | 154 | U2 | D2 | OK |
| ds_set_version_status | ds | design-system/ds-set-version-status.ts | 0 | 0 | 141 | U0 | D1 | ZERO-CALL |

**Telemetria de master/company na janela** (não extraíveis estaticamente ou com calls): spawn_subordinate_agent 4 · wait_for_subordinates 15 · forward_to_agent 19 · list_subordinates 22 · resume_subordinate 1 · respond_to_inbox 1 · post_to_board 29 · read_board 29 · kanban_move_card 33 · kanban_update_objectives 25 (12% err) · kanban_post_comment 15 · kanban_add_dependency 19 · kanban_assign_agent 17 · kanban_get_card 15 · kanban_read_my_card 17 · kanban_create_card 5 · kanban_list_cards 3 · kanban_move_to_review 2 (100% err!) · send_to_agent 2 (50% err) · read_my_inbox 6 · check_inbox_answer 2 · set_agent_status 4 · read_shared_file 20 · write_shared_file 14 · list_shared_files 3 · ds_record_component 63 · ds_component 13 (30,8% err) · ds_publish_version 9 (55,6% err) · ds_list_components 9 · ds_audit_package 7 · ds_get_session_info 6 · ds_docs 3 · ds_components 2.

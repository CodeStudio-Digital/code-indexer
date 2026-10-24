use super::*;
use crate::provider_context::resume::MEDIA_TYPE;
use sha2::{Digest, Sha256};

fn resumed_fixture() -> (Fixture, wire::ProviderResumeContextV1) {
    let mut fixture = Fixture::valid();
    let bytes =
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).unwrap();
    let context = wire::ProviderTurnContext::decode(bytes.as_slice()).unwrap();
    let frontier = wire::ProviderResumeContextV1 {
        schema_version: 1,
        session_id: "session-1".into(),
        agent_run_id: "run-1".into(),
        source_attempt_id: "attempt-1".into(),
        provider_binding: fixture.spec.provider_binding.clone(),
        context: Some(context),
        unresolved_capability_operation_ids: vec![],
    };
    fixture.spec.trigger = wire::AttemptTrigger::Resume as i32;
    fixture.spec.identity = Some(wire::AttemptIdentity {
        session_id: "session-1".into(),
        agent_run_id: "run-1".into(),
        attempt_id: "attempt-2".into(),
        ..wire::AttemptIdentity::default()
    });
    install(&mut fixture, &frontier);
    (fixture, frontier)
}

fn install(fixture: &mut Fixture, frontier: &wire::ProviderResumeContextV1) {
    let bytes = frontier.encode_to_vec();
    let reference = super::support::artifact("resume", MEDIA_TYPE, &bytes);
    fixture.spec.checkpoint_input = Some(reference.clone());
    fixture.material.artifacts = vec![(reference, bytes)];
}

#[test]
fn restores_prepared_boundary_context_only_for_its_authenticated_user_message() {
    let (mut fixture, mut frontier) = resumed_fixture();
    let context = frontier.context.as_mut().unwrap();
    context.prepared_boundary_context = Some(wire::ProviderPreparedBoundaryContextV1 {
        message_index: 0,
        source_message_sha256: Sha256::digest(context.messages[0].encode_to_vec()).to_vec(),
        content_utf8: "persisted recall".into(),
    });
    install(&mut fixture, &frontier);
    let restored =
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).unwrap();
    let restored = wire::ProviderTurnContext::decode(restored.as_slice()).unwrap();
    assert_eq!(
        restored.prepared_boundary_context,
        frontier.context.as_ref().unwrap().prepared_boundary_context
    );
    frontier
        .context
        .as_mut()
        .unwrap()
        .prepared_boundary_context
        .as_mut()
        .unwrap()
        .source_message_sha256[0] ^= 1;
    install(&mut fixture, &frontier);
    assert_eq!(
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material),
        Err(ProviderContextError::InvalidResumeInput)
    );
}

#[test]
fn resume_keeps_history_once_and_refreshes_current_catalog_and_provider_settings() {
    let (mut fixture, mut frontier) = resumed_fixture();
    frontier.context.as_mut().unwrap().previous_response_id = Some("response-1".into());
    frontier
        .context
        .as_mut()
        .unwrap()
        .previous_response_message_count = Some(1);
    install(&mut fixture, &frontier);
    let restored =
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).unwrap();
    let restored = wire::ProviderTurnContext::decode(restored.as_slice()).unwrap();
    assert_eq!(restored.messages.len(), 1);
    assert_eq!(restored.previous_response_id.as_deref(), Some("response-1"));
    fixture
        .spec
        .provider_binding
        .as_mut()
        .unwrap()
        .effective_model = "another-model".into();
    let restored =
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).unwrap();
    let restored = wire::ProviderTurnContext::decode(restored.as_slice()).unwrap();
    assert_eq!(restored.messages.len(), 1);
    assert!(restored.previous_response_id.is_none());
}

#[test]
fn rejects_foreign_corrupt_and_unreconciled_frontiers() {
    for kind in 0..6 {
        let (mut fixture, mut frontier) = resumed_fixture();
        match kind {
            0 => frontier.session_id = "foreign".into(),
            1 => frontier.agent_run_id = "foreign".into(),
            2 => frontier.source_attempt_id = "attempt-2".into(),
            3 => frontier
                .unresolved_capability_operation_ids
                .push("lost-ack".into()),
            4 => frontier.context.as_mut().unwrap().messages.clear(),
            _ => {}
        }
        install(&mut fixture, &frontier);
        if kind == 5 {
            fixture.material.artifacts[0].1[0] ^= 1;
        }
        assert_eq!(
            compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material),
            Err(ProviderContextError::InvalidResumeInput)
        );
    }
}

#[test]
fn interrupted_tool_use_cannot_be_replayed_as_a_resumed_frontier() {
    let (mut fixture, mut frontier) = resumed_fixture();
    frontier
        .context
        .as_mut()
        .unwrap()
        .messages
        .push(wire::ProviderMessage {
            role: wire::ProviderMessageRole::Assistant as i32,
            content: vec![wire::ProviderContentBlock {
                body: Some(wire::provider_content_block::Body::ToolUse(
                    wire::ProviderToolUseContent {
                        tool_use_id: "effect-1".into(),
                        capability_name: "edit_file".into(),
                        encoded_json_arguments: b"{}".to_vec(),
                        arguments_sha256: Sha256::digest(b"{}").to_vec(),
                    },
                )),
            }],
            ..wire::ProviderMessage::default()
        });
    install(&mut fixture, &frontier);
    assert_eq!(
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material),
        Err(ProviderContextError::InvalidResumeInput)
    );
}

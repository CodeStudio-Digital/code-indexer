use super::*;

fn install(fixture: &mut Fixture, snapshot: &wire::InitialConversationSnapshotV1) {
    let bytes = snapshot.encode_to_vec();
    let reference = wire::SnapshotRef {
        r#ref: "conversation".into(),
        version: 1,
        origin: "test".into(),
        schema_id: "codestudio.agent.v1.InitialConversationSnapshotV1".into(),
        schema_version: 1,
        content_sha256: vec![1; 32],
    };
    fixture
        .material
        .snapshots
        .retain(|(reference, _)| reference.r#ref != "conversation");
    fixture.material.snapshots.push((reference.clone(), bytes));
    fixture.spec.initial_conversation_snapshot = Some(reference);
}

#[test]
fn initial_conversation_preserves_history_and_the_current_task_exactly_once() {
    let mut fixture = Fixture::valid();
    fixture.spec.identity = Some(wire::AttemptIdentity {
        session_id: "session".into(),
        ..Default::default()
    });
    let task = super::super::task::initial_user_message(&fixture.spec, &fixture.material).unwrap();
    let mut earlier = task.clone();
    earlier.content = vec![wire::ProviderContentBlock {
        body: Some(wire::provider_content_block::Body::Text(
            wire::ProviderTextContent {
                body: Some(wire::provider_text_content::Body::InlineUtf8(
                    "earlier".into(),
                )),
            },
        )),
    }];
    let mut snapshot = wire::InitialConversationSnapshotV1 {
        schema_version: 1,
        session_id: "session".into(),
        messages: vec![earlier, task.clone()],
        prepared_user_context: Some(wire::ProviderPreparedUserContextV1 {
            message_index: 1,
            selected_skill_ids: vec!["review".into()],
            content_utf8: "frozen instructions".into(),
        }),
    };
    install(&mut fixture, &snapshot);
    let encoded =
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).unwrap();
    assert_eq!(
        wire::ProviderTurnContext::decode(encoded.as_slice())
            .unwrap()
            .messages,
        snapshot.messages
    );
    assert_eq!(
        wire::ProviderTurnContext::decode(encoded.as_slice())
            .unwrap()
            .prepared_user_context,
        snapshot.prepared_user_context
    );
    snapshot
        .prepared_user_context
        .as_mut()
        .unwrap()
        .message_index = 0;
    install(&mut fixture, &snapshot);
    assert!(compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).is_err());
    snapshot
        .prepared_user_context
        .as_mut()
        .unwrap()
        .message_index = 1;
    snapshot.messages.pop();
    install(&mut fixture, &snapshot);
    assert!(compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).is_err());
    snapshot.messages.push(task);
    snapshot.session_id = "foreign".into();
    install(&mut fixture, &snapshot);
    assert!(compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material).is_err());
}

use agent_protocol::generated::v1 as wire;
use prost::Message;

use super::{ProviderContextError, compose_initial_provider_context_from_spec};
use support::{Fixture, tool};

mod support;

#[test]
fn initial_context_is_composed_from_exact_hydrated_contracts() {
    let fixture = Fixture::valid();
    let encoded = compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material)
        .expect("initial provider context");
    let context = wire::ProviderTurnContext::decode(encoded.as_slice()).expect("context");

    assert_eq!(
        context.system.and_then(|system| system.body),
        Some(wire::provider_text_content::Body::InlineUtf8(
            "You are the native coder.".into(),
        ))
    );
    assert_eq!(context.messages.len(), 1);
    assert_eq!(
        context.messages[0].role,
        wire::ProviderMessageRole::User as i32
    );
    assert_eq!(context.messages[0].content.len(), 2);
    assert_eq!(context.tools.len(), 1);
    assert!(context.thinking);
    assert_eq!(context.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(context.thinking_budget_tokens, Some(2_048));
}

#[test]
fn snapshot_schema_identity_and_canonical_bytes_are_mandatory() {
    let mut wrong_schema = Fixture::valid();
    wrong_schema
        .spec
        .agent_definition_snapshot
        .as_mut()
        .expect("definition")
        .schema_id = "foreign.snapshot".into();
    assert_eq!(
        compose_initial_provider_context_from_spec(&wrong_schema.spec, &wrong_schema.material),
        Err(ProviderContextError::SnapshotContract(
            "agent_definition_snapshot"
        ))
    );

    let mut noncanonical = Fixture::valid();
    noncanonical.material.snapshots[6].1.extend([0x20, 0x00]);
    let reference = noncanonical
        .spec
        .agent_definition_snapshot
        .as_mut()
        .expect("definition");
    support::rehash_snapshot(reference, &noncanonical.material.snapshots[6].1);
    noncanonical.material.snapshots[6].0 = reference.clone();
    assert_eq!(
        compose_initial_provider_context_from_spec(&noncanonical.spec, &noncanonical.material),
        Err(ProviderContextError::NonCanonicalSnapshot(
            "agent_definition_snapshot"
        ))
    );
}

#[test]
fn capability_names_and_schema_hashes_fail_closed() {
    let mut duplicate = Fixture::valid();
    let mut capabilities = duplicate.capability_payload();
    capabilities.tools.push(capabilities.tools[0].clone());
    duplicate.replace_capabilities(&capabilities);
    assert_eq!(
        compose_initial_provider_context_from_spec(&duplicate.spec, &duplicate.material),
        Err(ProviderContextError::DuplicateTool { index: 1 })
    );

    let mut bad_hash = Fixture::valid();
    let mut descriptor = tool("filesystem.read");
    descriptor.schema_sha256[0] ^= 0xff;
    let mut capabilities = bad_hash.capability_payload();
    capabilities.tools = vec![descriptor];
    bad_hash.replace_capabilities(&capabilities);
    assert_eq!(
        compose_initial_provider_context_from_spec(&bad_hash.spec, &bad_hash.material),
        Err(ProviderContextError::ToolSchemaHashMismatch { index: 0 })
    );
}

#[test]
fn resume_inputs_and_incoherent_inference_options_are_not_smuggled() {
    let mut resume = Fixture::valid();
    resume.spec.trigger = wire::AttemptTrigger::Resume as i32;
    assert_eq!(
        compose_initial_provider_context_from_spec(&resume.spec, &resume.material),
        Err(ProviderContextError::UnsupportedTrigger(
            wire::AttemptTrigger::Resume as i32
        ))
    );

    let mut preset = Fixture::valid();
    let mut payload = preset.preset_payload();
    payload.thinking = false;
    payload.thinking_budget_tokens = Some(10);
    preset.replace_preset(&payload);
    assert_eq!(
        compose_initial_provider_context_from_spec(&preset.spec, &preset.material),
        Err(ProviderContextError::InvalidInferenceOptions)
    );
}

#[test]
fn task_artifact_must_be_hydrated_uncompressed_text_and_context_is_bounded() {
    let mut fixture = Fixture::with_task_artifact("Read the hydrated task.");
    let encoded = compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material)
        .expect("artifact task context");
    let context = wire::ProviderTurnContext::decode(encoded.as_slice()).expect("context");
    let text = context.messages[0].content[0].body.clone();
    assert!(matches!(
        text,
        Some(wire::provider_content_block::Body::Text(wire::ProviderTextContent {
            body: Some(wire::provider_text_content::Body::InlineUtf8(value)),
        })) if value == "Read the hydrated task."
    ));

    fixture
        .spec
        .resource_budget
        .as_mut()
        .expect("budget")
        .max_hot_transcript_bytes = 1;
    assert!(matches!(
        compose_initial_provider_context_from_spec(&fixture.spec, &fixture.material),
        Err(ProviderContextError::ContextTooLarge { maximum: 1, .. })
    ));
}

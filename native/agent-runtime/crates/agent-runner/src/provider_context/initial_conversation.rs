use agent_protocol::generated::v1 as wire;
use prost::Message;

use super::{ProviderContextError, ProviderContextMaterial, resume, task};

pub(super) fn context(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::ProviderTurnContext, ProviderContextError> {
    let Some(reference) = spec.initial_conversation_snapshot.as_ref() else {
        return Ok(wire::ProviderTurnContext {
            messages: vec![task::initial_user_message(spec, material)?],
            ..Default::default()
        });
    };
    let invalid = || ProviderContextError::SnapshotContract("initial_conversation_snapshot");
    if reference.schema_id != "codestudio.agent.v1.InitialConversationSnapshotV1"
        || reference.schema_version != 1
    {
        return Err(invalid());
    }
    let bytes =
        material
            .snapshot_payload(reference)
            .ok_or(ProviderContextError::MissingMaterial(
                "initial_conversation_snapshot",
            ))?;
    let snapshot = wire::InitialConversationSnapshotV1::decode(bytes).map_err(|_| invalid())?;
    if snapshot.encode_to_vec() != bytes
        || snapshot.schema_version != 1
        || snapshot.messages.len() > 100_000
        || spec
            .identity
            .as_ref()
            .is_none_or(|identity| identity.session_id != snapshot.session_id)
    {
        return Err(invalid());
    }
    let context = wire::ProviderTurnContext {
        messages: snapshot.messages,
        prepared_user_context: snapshot.prepared_user_context,
        ..Default::default()
    };
    resume::validate_frontier(&context)?;
    // Initial history already includes this command's user message. Requiring
    // the exact sealed task at the tail prevents omission or double insertion.
    if context.messages.last() != Some(&task::initial_user_message(spec, material)?) {
        return Err(invalid());
    }
    if context
        .prepared_user_context
        .as_ref()
        .is_some_and(|prepared| prepared.message_index as usize != context.messages.len() - 1)
    {
        return Err(invalid());
    }
    Ok(context)
}

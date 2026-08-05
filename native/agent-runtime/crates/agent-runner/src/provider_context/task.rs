use agent_protocol::generated::v1 as wire;

use super::{ProviderContextError, ProviderContextMaterial};

pub(super) fn initial_user_message(
    spec: &wire::ResolvedAttemptSpec,
    material: &impl ProviderContextMaterial,
) -> Result<wire::ProviderMessage, ProviderContextError> {
    let task = spec
        .task
        .as_ref()
        .ok_or(ProviderContextError::MissingValidatedField("task"))?;
    let body = task
        .body
        .as_ref()
        .ok_or(ProviderContextError::MissingValidatedField("task.body"))?;
    let text = match body {
        wire::task_input::Body::InlineUtf8(value) => value.clone(),
        wire::task_input::Body::Artifact(reference) => task_artifact(reference, material)?,
    };
    let mut content = Vec::with_capacity(task.attachments.len().saturating_add(1));
    content.push(wire::ProviderContentBlock {
        body: Some(wire::provider_content_block::Body::Text(
            wire::ProviderTextContent {
                body: Some(wire::provider_text_content::Body::InlineUtf8(text)),
            },
        )),
    });
    content.extend(
        task.attachments
            .iter()
            .cloned()
            .map(|attachment| wire::ProviderContentBlock {
                body: Some(wire::provider_content_block::Body::Attachment(attachment)),
            }),
    );
    Ok(wire::ProviderMessage {
        role: wire::ProviderMessageRole::User as i32,
        content,
        phase: wire::ProviderMessagePhase::Unspecified as i32,
        is_meta: false,
    })
}

fn task_artifact(
    reference: &wire::ArtifactRef,
    material: &impl ProviderContextMaterial,
) -> Result<String, ProviderContextError> {
    if wire::ArtifactCompression::try_from(reference.compression).ok()
        != Some(wire::ArtifactCompression::None)
    {
        return Err(ProviderContextError::InvalidTaskArtifact(
            "compression must be NONE",
        ));
    }
    if !matches!(
        reference.media_type.as_str(),
        "text/plain" | "text/markdown"
    ) {
        return Err(ProviderContextError::InvalidTaskArtifact(
            "media type must be text/plain or text/markdown",
        ));
    }
    let bytes = material
        .artifact_payload(reference)
        .ok_or(ProviderContextError::MissingTaskArtifact)?;
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| ProviderContextError::TaskArtifactNotUtf8)
}

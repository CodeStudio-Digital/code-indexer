use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;
use prost::Message;
use sha2::{Digest, Sha256};

use super::ProviderContextError;

pub(super) fn validate(context: &wire::ProviderTurnContext) -> Result<(), ProviderContextError> {
    let invalid = || ProviderContextError::InvalidResumeInput;
    if let Some(prepared) = &context.prepared_user_context {
        let message = context
            .messages
            .get(prepared.message_index as usize)
            .ok_or_else(invalid)?;
        let ids = &prepared.selected_skill_ids;
        if message.role != wire::ProviderMessageRole::User as i32
            || message.is_meta
            || ids.is_empty()
            || ids.len() > 32
            || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
            || ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128 || id.bytes().any(|b| b < 32))
            || prepared.content_utf8.is_empty()
            || prepared.content_utf8.len() > 128 * 1024
        {
            return Err(invalid());
        }
    }
    if let Some(prepared) = &context.prepared_boundary_context {
        let message = context
            .messages
            .get(prepared.message_index as usize)
            .ok_or_else(invalid)?;
        if message.role != wire::ProviderMessageRole::User as i32
            || message.is_meta
            || prepared.source_message_sha256.len() != 32
            || Sha256::digest(message.encode_to_vec()).as_slice() != prepared.source_message_sha256
            || prepared.content_utf8.is_empty()
            || prepared.content_utf8.len() > 32 * 1024
        {
            return Err(invalid());
        }
    }
    Ok(())
}

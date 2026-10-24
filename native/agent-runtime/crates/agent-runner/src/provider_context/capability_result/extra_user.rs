use agent_protocol::generated::v1 as wire;
use agent_tools::capability::CapabilityExecutionOutcome;
use prost::Message;

use super::{ProviderContextError, host_tool_result};

pub(super) fn message(
    outcome: &CapabilityExecutionOutcome,
) -> Result<Option<wire::ProviderMessage>, ProviderContextError> {
    let CapabilityExecutionOutcome::Succeeded(output) = outcome else {
        return Ok(None);
    };
    if output.schema_id != host_tool_result::SCHEMA_ID
        || output.schema_version != host_tool_result::SCHEMA_VERSION
    {
        return Ok(None);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.encoded_result).map_err(|_| invalid())?;
    let Some(encoded) = value.get("extraUserMessageHex") else {
        return Ok(None);
    };
    let encoded = encoded.as_str().ok_or_else(invalid)?;
    if encoded.is_empty()
        || encoded.len() > 512 * 1024
        || encoded.len() % 2 != 0
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    let bytes: Vec<u8> = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| (nibble(pair[0]) << 4) | nibble(pair[1]))
        .collect();
    let message = wire::ProviderMessage::decode(bytes.as_slice()).map_err(|_| invalid())?;
    if message.encode_to_vec() != bytes
        || message.role != wire::ProviderMessageRole::User as i32
        || message.is_meta
        || message.phase != wire::ProviderMessagePhase::Unspecified as i32
        || message.content.is_empty()
        || message.content.len() > 64
        || message.content.iter().any(|block| {
            !matches!(
                &block.body,
                Some(
                    wire::provider_content_block::Body::Attachment(_)
                        | wire::provider_content_block::Body::Text(wire::ProviderTextContent {
                            body: Some(wire::provider_text_content::Body::InlineUtf8(_))
                        })
                )
            )
        })
    {
        return Err(invalid());
    }
    Ok(Some(message))
}

const fn nibble(byte: u8) -> u8 {
    if byte <= b'9' {
        byte - b'0'
    } else {
        byte - b'a' + 10
    }
}

const fn invalid() -> ProviderContextError {
    ProviderContextError::InvalidCapabilityResult("invalid host tool user message")
}

#[cfg(test)]
mod tests;

use agent_protocol::generated::v1 as wire;
use serde_json::{Map, Value};

use super::CodexGatewayError;

pub(super) fn inline_text(value: &wire::ProviderTextContent) -> Option<String> {
    match value.body.as_ref() {
        Some(wire::provider_text_content::Body::InlineUtf8(text)) if !text.is_empty() => {
            Some(text.clone())
        }
        _ => None,
    }
}

pub(super) fn text<'a>(
    params: &'a Map<String, Value>,
    name: &str,
) -> Result<&'a str, CodexGatewayError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(CodexGatewayError::InvalidProtocol(
            "required text field is missing",
        ))
}

use std::collections::BTreeMap;

use agent_engine::operation::OperationId;
use agent_engine::ports::ProviderToolCall;
use agent_protocol::generated::v1 as wire;
use prost::Message;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::error::CodexGatewayError;

mod execution;
mod fields;

use execution::execution_class;
use fields::{inline_text, text};

const NAMESPACE: &str = "codestudio";
const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone)]
pub(super) struct ToolAuthority {
    pub descriptor: wire::ProviderToolDescriptor,
    pub input_schema: Value,
}

#[derive(Debug)]
pub(super) struct DecodedContext {
    pub prompt: String,
    pub tools: BTreeMap<String, ToolAuthority>,
}

#[derive(Debug)]
pub(super) struct PendingTool {
    pub request_id: Value,
    pub call_id: String,
}

pub(super) fn decode_context(bytes: &[u8]) -> Result<DecodedContext, CodexGatewayError> {
    let context = wire::ProviderTurnContext::decode(bytes)
        .map_err(|_| CodexGatewayError::InvalidContext("malformed ProviderTurnContext"))?;
    if context.encode_to_vec() != bytes {
        return Err(CodexGatewayError::InvalidContext(
            "non-canonical ProviderTurnContext",
        ));
    }
    let system = context.system.as_ref().and_then(inline_text);
    if context.prepared_user_context.is_some() {
        return Err(CodexGatewayError::InvalidContext(
            "prepared user context is not supported by this comparison adapter",
        ));
    }
    let user = context
        .messages
        .iter()
        .filter(|message| {
            wire::ProviderMessageRole::try_from(message.role).ok()
                == Some(wire::ProviderMessageRole::User)
        })
        .flat_map(|message| message.content.iter())
        .filter_map(|block| match block.body.as_ref() {
            Some(wire::provider_content_block::Body::Text(text)) => inline_text(text),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if user.is_empty() {
        return Err(CodexGatewayError::InvalidContext(
            "initial user text is missing",
        ));
    }
    let prompt = system.map_or_else(|| user.clone(), |system| format!("{system}\n\n{user}"));
    let mut tools = BTreeMap::new();
    for descriptor in context.tools {
        if descriptor.capability_name.is_empty()
            || descriptor.capability_id.is_empty()
            || descriptor.capability_version.is_empty()
            || tools.contains_key(&descriptor.capability_name)
        {
            return Err(CodexGatewayError::InvalidContext(
                "tool authority is invalid",
            ));
        }
        let schema = serde_json::from_slice(&descriptor.encoded_json_schema)?;
        tools.insert(
            descriptor.capability_name.clone(),
            ToolAuthority {
                descriptor,
                input_schema: schema,
            },
        );
    }
    Ok(DecodedContext { prompt, tools })
}

pub(super) fn thread_start_params(context: &DecodedContext, cwd: &str, model: &str) -> Value {
    let tools = context
        .tools
        .iter()
        .map(|(name, authority)| {
            json!({
                "type": "function",
                "name": name,
                "description": authority.descriptor.description,
                "inputSchema": authority.input_schema,
                "deferLoading": false,
            })
        })
        .collect::<Vec<_>>();
    let mut result = json!({
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandbox": "read-only",
        "serviceName": "codestudio_native_codex_adapter",
        "model": model,
        "dynamicTools": [{
            "type": "namespace",
            "name": NAMESPACE,
            "description": "Attempt-scoped tools authorized by CodeStudio",
            "tools": tools,
        }],
    });
    if model == "codex-default" {
        result
            .as_object_mut()
            .expect("object literal")
            .remove("model");
    }
    result
}

pub(super) fn turn_start_params(
    context: &DecodedContext,
    thread_id: &str,
    cwd: &str,
    model: &str,
) -> Value {
    let mut result = json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": context.prompt }],
        "cwd": cwd,
        "approvalPolicy": "never",
        "sandboxPolicy": { "type": "readOnly" },
        "model": model,
    });
    if model == "codex-default" {
        result
            .as_object_mut()
            .expect("object literal")
            .remove("model");
    }
    result
}

pub(super) fn parse_tool_call(
    request_id: Value,
    params: &Map<String, Value>,
    operation_id: &OperationId,
    tools: &BTreeMap<String, ToolAuthority>,
) -> Result<(ProviderToolCall, PendingTool), CodexGatewayError> {
    if text(params, "namespace")? != NAMESPACE {
        return Err(CodexGatewayError::InvalidProtocol(
            "tool namespace is not authorized",
        ));
    }
    let name = text(params, "tool")?;
    let authority = tools.get(name).ok_or(CodexGatewayError::InvalidProtocol(
        "tool is outside snapshot",
    ))?;
    let call_id = text(params, "callId")?.to_owned();
    let tool_use_id = OperationId::new(call_id.clone())
        .map_err(|_| CodexGatewayError::InvalidProtocol("tool call ID is invalid"))?;
    let arguments = params.get("arguments").and_then(Value::as_object).ok_or(
        CodexGatewayError::InvalidProtocol("tool arguments are invalid"),
    )?;
    let encoded_arguments = serde_json::to_vec(arguments)?;
    if encoded_arguments.is_empty() || encoded_arguments.len() > MAX_ARGUMENT_BYTES {
        return Err(CodexGatewayError::InvalidProtocol(
            "tool arguments exceed limit",
        ));
    }
    let execution_class = execution_class(authority.descriptor.execution_class)?;
    Ok((
        ProviderToolCall {
            operation_id: operation_id.clone(),
            tool_use_id,
            capability_name: name.to_owned(),
            capability_id: authority.descriptor.capability_id.clone(),
            capability_version: authority.descriptor.capability_version.clone(),
            execution_class,
            mutates: authority.descriptor.mutates,
            parallel_safe: authority.descriptor.parallel_safe,
            read_only: authority.descriptor.read_only,
            arguments_sha256: Sha256::digest(&encoded_arguments).into(),
            encoded_arguments,
            provider_response_id: None,
            provider_response_message_count: None,
        },
        PendingTool {
            request_id,
            call_id,
        },
    ))
}

pub(super) fn tool_result(bytes: &[u8], pending: &PendingTool) -> Result<Value, CodexGatewayError> {
    let turn_context = wire::ProviderTurnContext::decode(bytes)
        .map_err(|_| CodexGatewayError::InvalidContext("malformed continuation context"))?;
    if turn_context.encode_to_vec() != bytes {
        return Err(CodexGatewayError::InvalidContext(
            "non-canonical continuation context",
        ));
    }
    let result = turn_context
        .messages
        .last()
        .filter(|message| {
            wire::ProviderMessageRole::try_from(message.role).ok()
                == Some(wire::ProviderMessageRole::Tool)
        })
        .and_then(|message| message.content.first())
        .and_then(|block| match block.body.as_ref() {
            Some(wire::provider_content_block::Body::ToolResult(result)) => Some(result),
            _ => None,
        })
        .ok_or(CodexGatewayError::InvalidContext("tool result is missing"))?;
    if result.tool_use_id != pending.call_id {
        return Err(CodexGatewayError::InvalidContext(
            "tool result correlation mismatch",
        ));
    }
    let Some(wire::provider_tool_result_content::Content::InlineUtf8(inline_result)) =
        result.content.as_ref()
    else {
        return Err(CodexGatewayError::InvalidContext(
            "inline tool result is required",
        ));
    };
    Ok(json!({
        "contentItems": [{ "type": "inputText", "text": inline_result }],
        "success": !result.is_error,
    }))
}

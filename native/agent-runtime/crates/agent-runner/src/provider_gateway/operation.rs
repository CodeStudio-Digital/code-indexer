use std::collections::BTreeMap;

use agent_engine::operation::OperationId;
use agent_engine::ports::{ProviderEvent, ProviderToolCall};
use agent_protocol::generated::v1 as wire;

use super::ProviderGatewayError;

#[derive(Debug)]
pub struct ProviderDataOperation {
    pub(super) operation_id: OperationId,
    pub(super) tools: BTreeMap<String, wire::ProviderToolDescriptor>,
    pub(super) buffered: Option<ProviderEvent>,
    pub(super) pending_tool_calls: Vec<ProviderToolCall>,
    pub(super) terminal_delivered: bool,
}

impl ProviderDataOperation {
    pub(super) const fn new(
        operation_id: OperationId,
        tools: BTreeMap<String, wire::ProviderToolDescriptor>,
    ) -> Self {
        Self {
            operation_id,
            tools,
            buffered: None,
            pending_tool_calls: Vec::new(),
            terminal_delivered: false,
        }
    }

    #[cfg(test)]
    pub(super) const fn has_pending_tool_call(&self) -> bool {
        !self.pending_tool_calls.is_empty()
    }
}

pub(super) fn settle_provider_event(
    operation: &mut ProviderDataOperation,
    event: ProviderEvent,
) -> Result<Option<ProviderEvent>, ProviderGatewayError> {
    match event {
        ProviderEvent::ToolCall(call) => {
            if operation.pending_tool_calls.len() >= 256
                || operation
                    .pending_tool_calls
                    .iter()
                    .any(|previous| previous.tool_use_id == call.tool_use_id)
            {
                return Err(ProviderGatewayError::InvalidProviderEvent(
                    "duplicate tool use ID or tool batch limit exceeded",
                ));
            }
            operation.pending_tool_calls.push(call);
            Ok(None)
        }
        ProviderEvent::Completed {
            response_id,
            response_message_count,
        } => {
            let mut calls = std::mem::take(&mut operation.pending_tool_calls);
            for call in &mut calls {
                call.provider_response_id.clone_from(&response_id);
                call.provider_response_message_count =
                    response_id.as_ref().and(response_message_count);
            }
            Ok(Some(match calls.len() {
                0 => ProviderEvent::Completed {
                    response_id,
                    response_message_count,
                },
                1 => ProviderEvent::ToolCall(calls.remove(0)),
                _ => ProviderEvent::ToolCalls(calls),
            }))
        }
        ProviderEvent::Failed { .. } | ProviderEvent::Interrupted { .. } => {
            operation.pending_tool_calls.clear();
            Ok(Some(event))
        }
        _ => Ok(Some(event)),
    }
}

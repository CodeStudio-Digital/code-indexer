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
    pub(super) pending_tool_call: Option<ProviderToolCall>,
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
            pending_tool_call: None,
            terminal_delivered: false,
        }
    }

    #[cfg(test)]
    pub(super) const fn has_pending_tool_call(&self) -> bool {
        self.pending_tool_call.is_some()
    }
}

pub(super) fn settle_provider_event(
    operation: &mut ProviderDataOperation,
    event: ProviderEvent,
) -> Result<Option<ProviderEvent>, ProviderGatewayError> {
    match event {
        ProviderEvent::ToolCall(call) => {
            if operation.pending_tool_call.replace(call).is_some() {
                return Err(ProviderGatewayError::InvalidProviderEvent(
                    "parallel tool calls are not supported",
                ));
            }
            Ok(None)
        }
        ProviderEvent::Completed {
            response_id,
            response_message_count,
        } => match operation.pending_tool_call.take() {
            Some(mut call) => {
                call.provider_response_id = Some(response_id);
                call.provider_response_message_count = response_message_count;
                Ok(Some(ProviderEvent::ToolCall(call)))
            }
            None => Ok(Some(ProviderEvent::Completed {
                response_id,
                response_message_count,
            })),
        },
        ProviderEvent::TextDelta(_) | ProviderEvent::ThinkingDelta(_)
            if operation.pending_tool_call.is_some() =>
        {
            Err(ProviderGatewayError::InvalidProviderEvent(
                "content followed a completed tool call",
            ))
        }
        ProviderEvent::Failed { .. } | ProviderEvent::Interrupted { .. } => {
            operation.pending_tool_call = None;
            Ok(Some(event))
        }
        _ => Ok(Some(event)),
    }
}

use crate::lifecycle::InvalidRunTransition;
use crate::operation::OperationId;
use crate::ports::{ProviderToolCall, ProviderUsage};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnInput {
    pub operation_id: OperationId,
    pub encoded_context: Arc<[u8]>,
    pub deadline_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnOutcome {
    Completed {
        response_id: String,
        text: String,
        usage: Option<ProviderUsage>,
    },
    CapabilityRequired {
        call: ProviderToolCall,
        assistant_text: String,
        usage: Option<ProviderUsage>,
    },
    Failed {
        reason_code: &'static str,
    },
    Interrupted {
        reason_code: &'static str,
    },
}

#[derive(Debug)]
pub enum TurnEngineError<P, A, E, C> {
    Provider(P),
    Authority(A),
    EventSink(E),
    Clock(C),
    InvalidContext,
    InvalidDeadline,
    InvalidState,
    Transition(InvalidRunTransition),
}

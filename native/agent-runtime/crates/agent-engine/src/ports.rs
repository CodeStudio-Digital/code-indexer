use std::future::Future;
use std::sync::Arc;

use crate::operation::OperationId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorityCheckpoint {
    Hydration,
    ProviderStart,
    CapabilityPrepare,
    CapabilityDispatch,
    CapabilityEffect,
    TerminalDecision,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub cost_micros: u64,
}

impl ProviderUsage {
    #[must_use]
    pub const fn follows(self, previous: Self) -> bool {
        self.input_tokens >= previous.input_tokens
            && self.output_tokens >= previous.output_tokens
            && self.cached_input_tokens >= previous.cached_input_tokens
            && self.cost_micros >= previous.cost_micros
            && self.cached_input_tokens <= self.input_tokens
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRequest {
    pub operation_id: OperationId,
    pub encoded_context: Arc<[u8]>,
    pub deadline_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderToolCall {
    pub operation_id: OperationId,
    pub tool_use_id: OperationId,
    pub capability_name: String,
    pub capability_id: String,
    pub capability_version: String,
    pub execution_class: agent_tools::capability::ExecutionClass,
    pub mutates: bool,
    pub parallel_safe: bool,
    pub read_only: bool,
    pub encoded_arguments: Vec<u8>,
    pub arguments_sha256: [u8; 32],
    pub provider_response_id: Option<String>,
    pub provider_response_message_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    TextDelta(String),
    ThinkingDelta(String),
    Usage(ProviderUsage),
    ToolCall(ProviderToolCall),
    ToolCalls(Vec<ProviderToolCall>),
    Completed {
        response_id: Option<String>,
        response_message_count: Option<u64>,
    },
    Failed {
        reason_code: String,
    },
    Interrupted {
        reason_code: String,
    },
}

pub trait ProviderGatewayPort: Send {
    type Operation: Send;
    type Error: Send;

    fn start(
        &mut self,
        request: ProviderRequest,
    ) -> impl Future<Output = Result<Self::Operation, Self::Error>> + Send;

    fn next(
        &mut self,
        operation: &mut Self::Operation,
    ) -> impl Future<Output = Result<Option<ProviderEvent>, Self::Error>> + Send;
}

/// Persists a settled conversation frontier without opening a model stream.
pub trait ProviderFrontierPort: Send {
    type Error: Send;

    fn checkpoint(
        &mut self,
        request: ProviderRequest,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

pub trait AuthorityPort: Send {
    type Error: Send;

    fn verify(
        &mut self,
        checkpoint: AuthorityCheckpoint,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalClassification {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineEvent<'a> {
    ProviderStarted {
        operation_id: &'a str,
    },
    ProviderDelta {
        operation_id: &'a str,
        text: &'a str,
    },
    ProviderThinkingDelta {
        operation_id: &'a str,
        text: &'a str,
    },
    ProviderUsage {
        operation_id: &'a str,
        usage: ProviderUsage,
    },
    ProviderCompleted {
        operation_id: &'a str,
        response_id: Option<&'a str>,
    },
    CapabilityBoundary {
        operation_id: &'a str,
        tool_use_id: &'a str,
        call: &'a ProviderToolCall,
    },
    CapabilityDispatchStarted {
        operation_id: &'a str,
        tool_use_id: &'a str,
        grant_id: &'a str,
        effective_input_sha256: &'a [u8; 32],
        started_at_unix_ms: i64,
    },
    CapabilityRefused {
        operation_id: &'a str,
        tool_use_id: &'a str,
        rejection: &'a agent_tools::capability::CapabilityRejection,
    },
    CapabilityTerminal {
        operation_id: &'a str,
        tool_use_id: &'a str,
        grant_id: &'a str,
        outcome: &'a agent_tools::capability::CapabilityExecutionOutcome,
        completed_at_unix_ms: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalRecord<'a> {
    pub classification: TerminalClassification,
    pub reason_code: &'a str,
    pub usage: Option<ProviderUsage>,
}

pub trait EventSinkPort: Send {
    type Error: Send;

    fn append(
        &mut self,
        event: EngineEvent<'_>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn commit_terminal(
        &mut self,
        terminal: TerminalRecord<'_>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;
}

pub trait ClockPort: Send {
    type Error: Send;

    fn now_unix_ms(&mut self) -> impl Future<Output = Result<i64, Self::Error>> + Send;
}

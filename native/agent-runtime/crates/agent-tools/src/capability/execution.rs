use std::future::Future;

use super::{CapabilityInvocation, SealedExecutionGrant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityOutput {
    pub schema_id: String,
    pub schema_version: u32,
    pub encoded_result: Vec<u8>,
    pub result_sha256: [u8; 32],
    pub bytes_read: u64,
    pub bytes_emitted: u64,
    pub truncated: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityFailure {
    pub reason_code: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CapabilityExecutionOutcome {
    Succeeded(CapabilityOutput),
    Failed(CapabilityFailure),
    Cancelled(CapabilityFailure),
    OutcomeUnknown(CapabilityFailure),
}

pub trait CapabilityExecutorPort: Send {
    type Error: Send;

    fn execute(
        &mut self,
        invocation: &CapabilityInvocation,
        grant: &SealedExecutionGrant,
    ) -> impl Future<Output = Result<CapabilityExecutionOutcome, Self::Error>> + Send;
}

/// Bounded Host read windows. Each invocation has already crossed its own
/// durable started boundary; results arrive independently in completion order.
pub trait CapabilityReadBatchPort: CapabilityExecutorPort {
    fn start_read_batch(
        &mut self,
        members: &[(CapabilityInvocation, SealedExecutionGrant)],
    ) -> impl Future<Output = Result<(), Self::Error>> + Send;

    fn next_read_result(
        &mut self,
    ) -> impl Future<Output = Result<(String, CapabilityExecutionOutcome), Self::Error>> + Send;
}

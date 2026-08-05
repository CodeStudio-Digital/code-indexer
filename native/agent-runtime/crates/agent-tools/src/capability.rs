use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::future::Future;

mod decision;
mod execution;
mod invocation;

pub use decision::{
    CapabilityApproval, CapabilityDecision, CapabilityRejection, NativeFilesystemReadBinding,
    SealedExecutionGrant,
};
pub use execution::{
    CapabilityExecutionOutcome, CapabilityExecutorPort, CapabilityFailure, CapabilityOutput,
};
pub use invocation::{CapabilityInvocation, ExecutionClass, InvocationValidationError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionBoundary {
    Native,
    HostDelegated,
    DisposableChild,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityDescriptor {
    pub id: String,
    pub version: u32,
    pub execution_boundary: ExecutionBoundary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DescriptorError {
    EmptyIdentifier,
    UnspecifiedVersion,
}

impl Display for DescriptorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid capability descriptor: {self:?}")
    }
}

impl Error for DescriptorError {}

impl CapabilityDescriptor {
    /// Validates the stable identity of a capability.
    ///
    /// # Errors
    ///
    /// Returns [`DescriptorError`] for an empty identifier or version zero.
    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.id.trim().is_empty() {
            return Err(DescriptorError::EmptyIdentifier);
        }
        if self.version == 0 {
            return Err(DescriptorError::UnspecifiedVersion);
        }
        Ok(())
    }
}

pub trait CapabilityGatewayPort: Send {
    type Error: Send;

    fn prepare(
        &mut self,
        invocation: CapabilityInvocation,
    ) -> impl Future<Output = Result<CapabilityDecision, Self::Error>> + Send;
}

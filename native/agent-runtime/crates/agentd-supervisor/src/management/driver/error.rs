use agent_protocol::management_channel::ManagementChannelError;

use super::state::CleanupStateError;
use crate::process_table::OwnershipError;

#[derive(Debug)]
pub enum SupervisorDriverCreateError {
    Ownership(OwnershipError),
    InvalidCapacity,
    InvalidClock,
}

#[derive(Debug)]
pub enum SupervisorDriverError<P> {
    Channel(ManagementChannelError),
    InvalidLaunchPlan,
    InvalidTerminationPlan,
    TerminationConflict,
    ShutdownConflict,
    UnknownTerminationTarget,
    ProvisionReceiptMismatch,
    CleanupState(CleanupStateError),
    Ownership(OwnershipError),
    Platform(P),
    PhysicalReceiptMismatch,
    FactFlowInvariant,
    UntrackedAcknowledgement,
    UnsupportedInbound(&'static str),
}

impl<P> From<ManagementChannelError> for SupervisorDriverError<P> {
    fn from(value: ManagementChannelError) -> Self {
        Self::Channel(value)
    }
}

impl<P> From<CleanupStateError> for SupervisorDriverError<P> {
    fn from(value: CleanupStateError) -> Self {
        Self::CleanupState(value)
    }
}

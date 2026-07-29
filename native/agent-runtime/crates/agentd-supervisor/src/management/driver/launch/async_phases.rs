use super::super::provision::{ProtectedLaunchPhysicalFacts, ProtectedLaunchReceipt};
use super::super::reporting::PreparedLaunchEmission;
use super::super::state::CleanupStateError;
use super::worker::RemoteLaunchCleanup;

mod clock;
mod completion;
mod prepare;
mod spawn;

pub(in crate::management) enum AsyncLaunchPrepareOutcome {
    Spawn,
    Resolve(PreparedLaunchEmission),
    Stop(Result<PreparedLaunchEmission, CleanupStateError>),
}

pub(in crate::management) enum AsyncLaunchSpawnOutcome {
    Complete(ProtectedLaunchPhysicalFacts),
    Resolve(PreparedLaunchEmission),
    Stop(Result<PreparedLaunchEmission, CleanupStateError>),
}

pub(in crate::management) enum AsyncWorkerCompletion {
    Completed(Box<ProtectedLaunchReceipt>),
    CleanupRequired(RemoteLaunchCleanup),
}

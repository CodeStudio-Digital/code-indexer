use agent_platform::containment::ProcessId;

use super::{AttemptRuntimeMetadata, ObservedExit, PhysicalState};

#[derive(Debug)]
pub(super) struct Owned<S> {
    pub(super) metadata: AttemptRuntimeMetadata,
    pub(super) reservation: crate::admission::ReservationToken,
    pub(super) state: S,
}

#[derive(Debug)]
pub(super) struct Physical<G> {
    pub(super) group: G,
    pub(super) process_id: ProcessId,
    pub(super) report: agent_platform::containment::ContainmentReport,
}

#[derive(Debug)]
pub(super) struct Launching {
    pub(super) termination_exit_code: Option<u32>,
}

#[derive(Debug)]
pub(super) struct BootstrapPending<G> {
    pub(super) physical: Physical<G>,
    pub(super) termination_exit_code: Option<u32>,
    pub(super) observed_exit: Option<ObservedExit>,
}

#[derive(Debug)]
pub(super) struct Reserved<G>(pub(super) Physical<G>);

#[derive(Debug)]
pub(super) struct Running<G>(pub(super) Physical<G>);

#[derive(Debug)]
pub(super) struct Cancelling<G>(pub(super) Physical<G>);

#[derive(Debug)]
pub(super) struct Exited<G> {
    pub(super) physical: Physical<G>,
    pub(super) observed: ObservedExit,
}

#[derive(Debug)]
pub(super) struct Reaping<G> {
    pub(super) physical: Physical<G>,
    pub(super) observed: Option<ObservedExit>,
}

/// Fail-closed ownership after physical proof or admission release became
/// internally inconsistent. Its bounded slot and ledger accounting remain
/// poisoned and cannot be reused.
#[derive(Debug)]
pub(super) struct Quarantined {
    pub(super) metadata: AttemptRuntimeMetadata,
}

#[derive(Debug)]
pub(super) enum Entry<G> {
    Launching(Owned<Launching>),
    BootstrapPending(Owned<BootstrapPending<G>>),
    Reserved(Owned<Reserved<G>>),
    Running(Owned<Running<G>>),
    Cancelling(Owned<Cancelling<G>>),
    Exited(Owned<Exited<G>>),
    Reaping(Owned<Reaping<G>>),
    Quarantined(Quarantined),
}

impl<G> Entry<G> {
    pub(super) const fn metadata(&self) -> &AttemptRuntimeMetadata {
        match self {
            Self::Launching(owned) => &owned.metadata,
            Self::BootstrapPending(owned) => &owned.metadata,
            Self::Reserved(owned) => &owned.metadata,
            Self::Running(owned) => &owned.metadata,
            Self::Cancelling(owned) => &owned.metadata,
            Self::Exited(owned) => &owned.metadata,
            Self::Reaping(owned) => &owned.metadata,
            Self::Quarantined(quarantined) => &quarantined.metadata,
        }
    }

    pub(super) const fn state(&self) -> PhysicalState {
        match self {
            Self::Launching(_) | Self::BootstrapPending(_) | Self::Reserved(_) => {
                PhysicalState::Reserved
            }
            Self::Running(_) => PhysicalState::Running,
            Self::Cancelling(_) => PhysicalState::Cancelling,
            Self::Exited(_) => PhysicalState::Exited,
            Self::Reaping(_) => PhysicalState::Reaping,
            Self::Quarantined(_) => PhysicalState::Quarantined,
        }
    }
}

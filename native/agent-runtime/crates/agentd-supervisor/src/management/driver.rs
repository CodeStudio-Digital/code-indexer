use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};

use agent_platform::containment::ContainmentPort;

use super::SupervisorManagementChannel;
use super::online_lifecycle::SystemSupervisorLifecycleClock;
#[cfg(test)]
use cleanup::FixedLifecycleClock;

mod ack;
mod authority;
mod authority_registry;
mod cleanup;
mod completion_cleanup;
mod config;
mod core;
mod error;
mod fact_flow;
pub(super) mod facts;
mod inbound;
mod launch;
mod launch_registry;
mod lifecycle_fact_outbox;
mod lifecycle_reporting;
mod plan;
mod provision;
mod pulse_registry;
mod reporting;
mod shutdown;
mod spawn;
mod state;
mod termination;

pub(in crate::management) use ack::PreparedFactEmission;
pub use config::{TrustedRunnerConfig, TrustedRunnerConfigError, TrustedRunnerProvenance};
pub use core::SupervisorLifecycleCore;
pub use error::{SupervisorDriverCreateError, SupervisorDriverError};
pub(in crate::management) use launch::{
    AsyncLaunchPrepareOutcome, AsyncLaunchSpawnOutcome, AsyncLaunchStart, AsyncWorkerCompletion,
    PendingPhysicalLaunchWorker, PhysicalLaunchState, PhysicalLaunchWorkerCommand,
    PhysicalLaunchWorkerEvent,
};
pub use provision::{
    FailClosedProtectedLaunchProvisioner, PendingProtectedLaunch, PreparedProtectedLaunch,
    ProtectedLaunchCleanupOwner, ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
    ProtectedLaunchCompletion, ProtectedLaunchCompletionFailure, ProtectedLaunchPeerAuthority,
    ProtectedLaunchPeerAuthorityError, ProtectedLaunchPhysicalFacts, ProtectedLaunchProvisionError,
    ProtectedLaunchProvisionPort, ProtectedLaunchReceipt, ProtectedLaunchRequest,
};
#[cfg(windows)]
pub use provision::{
    WindowsProtectedLaunchCancellation, WindowsProtectedLaunchCleanup, WindowsProtectedLaunchError,
    WindowsProtectedLaunchProvisioner,
};
#[allow(
    unused_imports,
    reason = "transport-neutral Launch emission is consumed by the async management adapter"
)]
pub(in crate::management) use reporting::PreparedLaunchEmission;
pub use state::{AdmissionClosureReason, CleanupPhase, CleanupStateError, SupervisorDriverState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorDriverStep {
    Replay,
    ManagementAcknowledged,
    AuthorityUpdated { reused_existing: bool },
    LaunchAccepted { reused_existing: bool },
    LaunchRejected { reason_code: &'static str },
    CancelScheduled { reused_existing: bool },
    FenceScheduled { reused_existing: bool },
    ReapScheduled { reused_existing: bool },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CleanupDriveReport {
    pub termination_attempts: usize,
    pub termination_failures: usize,
    pub provision_cleanup_attempts: usize,
    pub provision_cleanup_failures: usize,
    pub provision_cleanup_stalls: usize,
    pub reap_attempts: usize,
    pub reaped: usize,
    pub retained_for_reap: usize,
}

/// Typed synchronous coordinator for validated management, protected launch
/// provisioning, single-tenant ownership, and containment.
///
/// The Windows provisioner completes the protected bootstrap with overlapped
/// Named Pipe I/O and retains any pending cleanup beside physical ownership.
/// Product launch remains fail-closed until every platform path and host
/// integration gate is complete.
#[derive(Debug)]
pub struct SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    channel: SupervisorManagementChannel<R, W>,
    pub(super) core: SupervisorLifecycleCore<P, V>,
    lifecycle_clock: SystemSupervisorLifecycleClock,
}

impl<R, W, P, V> SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    /// Creates the coordinator with capacity sealed by the management policy.
    ///
    /// # Errors
    ///
    /// Fails when the private ownership ledger cannot start.
    pub fn new(
        channel: SupervisorManagementChannel<R, W>,
        containment: P,
        provisioner: V,
        trusted_runner: TrustedRunnerConfig,
        peer_authority: ProtectedLaunchPeerAuthority,
    ) -> Result<Self, SupervisorDriverCreateError> {
        let core = SupervisorLifecycleCore::new(
            channel.policy().clone(),
            containment,
            provisioner,
            trusted_runner,
            peer_authority,
        )?;
        let lifecycle_clock = SystemSupervisorLifecycleClock::new()
            .map_err(|_| SupervisorDriverCreateError::InvalidClock)?;
        Ok(Self {
            channel,
            core,
            lifecycle_clock,
        })
    }

    /// Processes one validated inbound transaction or exact replay.
    ///
    /// # Errors
    ///
    /// Any channel failure closes admission and schedules owned attempts for
    /// grace/termination/reap. Unsupported payloads are rejected and poison
    /// the stream rather than remaining pending.
    pub fn process_next(
        &mut self,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let received = self.channel.begin_receive();
        let now_unix_ms = self.channel.owner_now_unix_ms();
        let lifecycle_clock = self.lifecycle_clock.clone();
        self.process_received(received, now_unix_ms, now_unix_ms, &lifecycle_clock)
    }

    #[cfg(test)]
    fn process_next_at(
        &mut self,
        now_unix_ms: i64,
    ) -> Result<SupervisorDriverStep, SupervisorDriverError<P::Error>> {
        let received = self.channel.begin_receive();
        let launch_now_unix_ms = now_unix_ms.min(self.channel.owner_now_unix_ms());
        self.process_received(
            received,
            now_unix_ms,
            launch_now_unix_ms,
            &FixedLifecycleClock::new(launch_now_unix_ms),
        )
    }

    #[must_use]
    pub const fn state(&self) -> &SupervisorDriverState {
        &self.core.state
    }

    #[must_use]
    pub fn owned_attempts(&self) -> usize {
        self.ownership.len()
    }

    #[must_use]
    pub const fn reserved_memory_bytes(&self) -> u64 {
        self.core.ownership.reserved_memory_bytes()
    }

    #[must_use]
    pub const fn reserved_processes(&self) -> u32 {
        self.core.ownership.reserved_processes()
    }

    #[must_use]
    pub const fn is_channel_poisoned(&self) -> bool {
        self.channel.is_poisoned()
    }

    #[must_use]
    pub fn pending_management_facts(&self) -> usize {
        self.fact_flow.len()
    }
}

impl<R, W, P, V> Deref for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    type Target = SupervisorLifecycleCore<P, V>;

    fn deref(&self) -> &Self::Target {
        &self.core
    }
}

impl<R, W, P, V> DerefMut for SupervisorPhysicalDriver<R, W, P, V>
where
    R: Read,
    W: Write,
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.core
    }
}

#[cfg(test)]
mod tests;

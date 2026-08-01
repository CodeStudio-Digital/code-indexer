use std::sync::Arc;

use agent_platform::containment::ContainmentPort;
use agent_protocol::management_channel::ManagementSessionPolicy;

use super::completion_cleanup::{CompletionCleanupRegistry, ManagedLaunchCleanup};
use super::fact_flow::FactFlow;
use super::launch_registry::LaunchRegistry;
use super::provision::{ProtectedLaunchPeerAuthority, ProtectedLaunchProvisionPort};
use super::pulse_registry::PulseRegistry;
use super::shutdown::ShutdownRegistry;
use super::{SupervisorDriverCreateError, SupervisorDriverState, TrustedRunnerConfig};
use crate::admission::SupervisorCapacity;
use crate::process_table::OwnershipRegistry;

/// Transport-free owner of all physical lifecycle resources and state.
///
/// Management stream ownership remains in the protocol actor or synchronous
/// adapter. Neither can mutate containment without this unique owner.
pub struct SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) policy: ManagementSessionPolicy,
    pub(super) ownership: OwnershipRegistry<P::Group>,
    pub(super) containment: Arc<P>,
    pub(super) provisioner: Arc<V>,
    pub(super) trusted_runner: TrustedRunnerConfig,
    pub(super) peer_authority: ProtectedLaunchPeerAuthority,
    pub(super) state: SupervisorDriverState,
    pub(super) fact_flow: FactFlow,
    pub(super) launch_registry: LaunchRegistry,
    pub(super) shutdown_registry: ShutdownRegistry,
    pub(super) completion_cleanup: CompletionCleanupRegistry<ManagedLaunchCleanup<V::Cleanup>>,
    pub(super) pulse_registry: PulseRegistry,
    pub(super) last_observed_at_unix_ms: Option<i64>,
}

impl<P, V> std::fmt::Debug for SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SupervisorLifecycleCore")
            .field("policy", &self.policy)
            .field("owned_attempts", &self.ownership.len())
            .field("state", &self.state)
            .field("pending_management_facts", &self.fact_flow.len())
            .field("last_observed_at_unix_ms", &self.last_observed_at_unix_ms)
            .finish_non_exhaustive()
    }
}

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    /// Creates the physical owner using already-negotiated management limits.
    ///
    /// # Errors
    ///
    /// Rejects invalid aggregate capacities or unrepresentable bounded
    /// registries before accepting any physical ownership.
    pub fn new(
        policy: ManagementSessionPolicy,
        containment: P,
        provisioner: V,
        trusted_runner: TrustedRunnerConfig,
        peer_authority: ProtectedLaunchPeerAuthority,
    ) -> Result<Self, SupervisorDriverCreateError> {
        let limits = policy.limits();
        let maximum_active = usize::try_from(limits.max_active_attempts)
            .map_err(|_| SupervisorDriverCreateError::InvalidCapacity)?;
        let maximum_pending = usize::try_from(limits.max_pending_launches)
            .map_err(|_| SupervisorDriverCreateError::InvalidCapacity)?;
        let maximum_launches = maximum_active
            .checked_add(maximum_pending)
            .ok_or(SupervisorDriverCreateError::InvalidCapacity)?;
        let maximum_facts = usize::try_from(policy.frame_limits().max_in_flight_frames)
            .map_err(|_| SupervisorDriverCreateError::InvalidCapacity)?;
        let ownership = OwnershipRegistry::new(SupervisorCapacity {
            max_active_attempts: limits.max_active_attempts,
            max_reserved_memory_bytes: limits.max_reserved_memory_bytes,
            max_reserved_processes: limits.max_reserved_processes,
        })
        .map_err(SupervisorDriverCreateError::Ownership)?;
        Ok(Self {
            policy,
            ownership,
            containment: Arc::new(containment),
            provisioner: Arc::new(provisioner),
            trusted_runner,
            peer_authority,
            state: SupervisorDriverState::default(),
            fact_flow: FactFlow::new(maximum_facts),
            launch_registry: LaunchRegistry::new(maximum_launches),
            shutdown_registry: ShutdownRegistry::default(),
            completion_cleanup: CompletionCleanupRegistry::new(maximum_active),
            pulse_registry: PulseRegistry::new(maximum_active),
            last_observed_at_unix_ms: None,
        })
    }

    #[must_use]
    pub const fn state(&self) -> &SupervisorDriverState {
        &self.state
    }

    #[must_use]
    pub fn owned_attempts(&self) -> usize {
        self.ownership.len()
    }

    #[must_use]
    pub const fn reserved_memory_bytes(&self) -> u64 {
        self.ownership.reserved_memory_bytes()
    }

    #[must_use]
    pub const fn reserved_processes(&self) -> u32 {
        self.ownership.reserved_processes()
    }

    #[must_use]
    pub fn pending_management_facts(&self) -> usize {
        self.fact_flow.len()
    }

    pub(in crate::management) fn physical_ports(&self) -> (Arc<P>, Arc<V>) {
        (Arc::clone(&self.containment), Arc::clone(&self.provisioner))
    }

    pub(in crate::management) fn next_physical_deadline_unix_ms(&self) -> Option<i64> {
        match (
            self.state.next_cleanup_deadline_unix_ms(),
            self.pulse_registry.next_deadline_unix_ms(),
        ) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        }
    }
}

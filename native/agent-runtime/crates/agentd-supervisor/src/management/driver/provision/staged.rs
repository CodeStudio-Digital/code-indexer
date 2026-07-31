use std::fmt::{self, Debug, Formatter};

use agent_platform::containment::{ChildHandleAllowlist, ContainmentReport};
use agent_protocol::generated::v1 as wire;
#[cfg(windows)]
use agent_protocol::runner_bootstrap::MatchedRunnerEndpointsReady;

use super::facts::ProtectedLaunchHandoffFacts;
use super::peer::ProtectedLaunchPeerAuthority;
#[cfg(any(test, windows))]
use super::receipt::ProtectedLaunchReceipt;
use super::request::ProtectedLaunchRequest;
use super::seal::ProtectedLaunchSeal;
use crate::management::driver::facts::containment_to_wire;
use crate::process_table::PhysicalSpawnReceipt;

/// Linear pre-spawn owner of exact inherited handles and provider state.
pub struct PreparedProtectedLaunch<P> {
    child_handles: ChildHandleAllowlist,
    pending: PendingProtectedLaunch<P>,
}

/// Linear post-spawn owner required to complete protected handoff.
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes pending state; other platform provisioners remain gated"
    )
)]
pub struct PendingProtectedLaunch<P> {
    seal: ProtectedLaunchSeal,
    handoff_facts: ProtectedLaunchHandoffFacts,
    provider: P,
}

/// Supervisor-minted physical facts available only after contained spawn.
#[derive(Clone, PartialEq, Eq)]
pub struct ProtectedLaunchPhysicalFacts {
    process_id: u32,
    resource_group_id: String,
    reservation_id: String,
    containment_report: ContainmentReport,
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows prepared minting is internal; other platforms remain gated"
    )
)]
impl<P> PreparedProtectedLaunch<P> {
    #[must_use]
    pub(in crate::management::driver) fn new(
        request: &ProtectedLaunchRequest<'_>,
        child_handles: ChildHandleAllowlist,
        provider: P,
    ) -> Self {
        Self {
            child_handles,
            pending: PendingProtectedLaunch {
                seal: ProtectedLaunchSeal::from_request(request),
                handoff_facts: ProtectedLaunchHandoffFacts::from_request(request),
                provider,
            },
        }
    }

    pub(in crate::management::driver) fn into_spawn_parts(
        self,
    ) -> (ChildHandleAllowlist, PendingProtectedLaunch<P>) {
        (self.child_handles, self.pending)
    }
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes pending state; other platform provisioners remain gated"
    )
)]
impl<P> PendingProtectedLaunch<P> {
    #[must_use]
    pub(in crate::management::driver) const fn handoff_facts(
        &self,
    ) -> &ProtectedLaunchHandoffFacts {
        &self.handoff_facts
    }

    #[must_use]
    pub(in crate::management::driver) const fn provider(&self) -> &P {
        &self.provider
    }

    #[must_use]
    pub(in crate::management::driver) const fn provider_mut(&mut self) -> &mut P {
        &mut self.provider
    }

    #[must_use]
    #[cfg(windows)]
    pub(in crate::management::driver) fn mint_receipt(
        self,
        physical: &ProtectedLaunchPhysicalFacts,
        _ready: MatchedRunnerEndpointsReady,
    ) -> ProtectedLaunchReceipt {
        ProtectedLaunchReceipt::new(self.seal, physical.clone())
    }

    #[must_use]
    #[cfg(test)]
    pub(in crate::management::driver) fn mint_receipt_for_test(
        self,
        physical: &ProtectedLaunchPhysicalFacts,
    ) -> ProtectedLaunchReceipt {
        ProtectedLaunchReceipt::new_for_test(self.seal, physical.clone())
    }
}

impl ProtectedLaunchPhysicalFacts {
    pub(super) fn from_spawn_receipt(receipt: &PhysicalSpawnReceipt) -> Self {
        Self {
            process_id: receipt.process_id().0,
            resource_group_id: receipt.metadata().resource_group_id.0.clone(),
            reservation_id: receipt.reservation_id().to_owned(),
            containment_report: receipt.containment_report().clone(),
        }
    }

    #[must_use]
    pub const fn process_id(&self) -> u32 {
        self.process_id
    }

    #[must_use]
    pub const fn containment_report(&self) -> &ContainmentReport {
        &self.containment_report
    }

    #[must_use]
    pub fn effective_containment_wire(&self) -> wire::ContainmentReport {
        containment_to_wire(&self.containment_report)
    }

    pub(in crate::management::driver) const fn runner_is_distinct_from(
        &self,
        peer_authority: &ProtectedLaunchPeerAuthority,
    ) -> bool {
        !peer_authority.contains_process_id(self.process_id)
    }

    #[cfg(all(test, windows))]
    pub(in crate::management::driver) fn new_for_windows_test(
        process_id: u32,
        containment_report: ContainmentReport,
    ) -> Self {
        Self {
            process_id,
            resource_group_id: "windows-provision-test".into(),
            reservation_id: "windows-provision-test".into(),
            containment_report,
        }
    }
}

impl<P> Debug for PreparedProtectedLaunch<P> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedProtectedLaunch")
            .field("child_handle_count", &self.child_handles.len())
            .field("pending", &"[REDACTED]")
            .finish()
    }
}

impl<P> Debug for PendingProtectedLaunch<P> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingProtectedLaunch([REDACTED])")
    }
}

impl Debug for ProtectedLaunchPhysicalFacts {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchPhysicalFacts")
            .field("process_id", &"[REDACTED]")
            .field("resource_group_id", &"[REDACTED]")
            .field("reservation_id", &"[REDACTED]")
            .field("containment_report", &self.containment_report)
            .finish()
    }
}

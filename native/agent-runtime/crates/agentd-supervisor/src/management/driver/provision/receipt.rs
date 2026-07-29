use std::fmt::{self, Debug, Formatter};

use super::ProtectedLaunchProvisionError;
use super::peer::ProtectedLaunchPeerAuthority;
use super::seal::ProtectedLaunchSeal;
use super::staged::ProtectedLaunchPhysicalFacts;
use crate::management::driver::plan::LaunchPlan;

/// Opaque proof minted only after protected handoff completes against physical
/// spawn facts.
///
/// Production callers cannot forge it:
///
/// ```compile_fail
/// use agentd_supervisor::management::ProtectedLaunchReceipt;
///
/// let _forged = ProtectedLaunchReceipt {};
/// ```
#[derive(PartialEq, Eq)]
pub struct ProtectedLaunchReceipt {
    seal: ProtectedLaunchSeal,
    physical: ProtectedLaunchPhysicalFacts,
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows receipt minting is internal; other platforms remain gated"
    )
)]
impl ProtectedLaunchReceipt {
    pub(super) const fn new(
        seal: ProtectedLaunchSeal,
        physical: ProtectedLaunchPhysicalFacts,
    ) -> Self {
        Self { seal, physical }
    }

    #[cfg(test)]
    pub(super) const fn new_for_test(
        seal: ProtectedLaunchSeal,
        physical: ProtectedLaunchPhysicalFacts,
    ) -> Self {
        Self { seal, physical }
    }

    pub(in crate::management::driver) fn validate(
        &self,
        plan: &LaunchPlan,
        peer_authority: &ProtectedLaunchPeerAuthority,
        physical: &ProtectedLaunchPhysicalFacts,
    ) -> Result<(), ProtectedLaunchProvisionError> {
        if !self.seal.matches(plan, peer_authority) || self.physical != *physical {
            return Err(ProtectedLaunchProvisionError::ReceiptMismatch);
        }
        Ok(())
    }
}

impl Debug for ProtectedLaunchReceipt {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchReceipt")
            .field("seal", &self.seal)
            .field("physical", &self.physical)
            .finish()
    }
}

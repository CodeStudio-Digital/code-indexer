use agent_platform::containment::ContainmentPort;
use agent_protocol::generated::v1 as wire;

use super::fact_flow::{FactIntent, PendingFactAction, PendingFactStage};
use super::facts::{AttemptExitedFact, AttemptReapedFact};
use super::provision::ProtectedLaunchProvisionPort;
use super::{PreparedFactEmission, SupervisorLifecycleCore};
use crate::process_table::{OwnershipKey, ReapedAttempt};

impl<P, V> SupervisorLifecycleCore<P, V>
where
    P: ContainmentPort,
    V: ProtectedLaunchProvisionPort,
{
    pub(super) fn can_stage_lifecycle_fact(&self) -> bool {
        self.lifecycle_fact_outbox.has_capacity()
    }

    pub(super) fn stage_reaped_lifecycle(
        &mut self,
        key: &OwnershipKey,
        reaped: &ReapedAttempt,
        cause: wire::PhysicalExitCause,
        reaped_at_unix_ms: i64,
    ) -> bool {
        let exited = AttemptExitedFact::new(reaped, &self.trusted_runner, cause);
        let reaped = AttemptReapedFact::new(reaped, reaped_at_unix_ms);
        self.lifecycle_fact_outbox.push(PreparedFactEmission::new(
            exited.to_wire(),
            PendingFactAction::new(
                FactIntent::Unregistered,
                PendingFactStage::Exited {
                    key: key.clone(),
                    reaped: Box::new(reaped),
                },
            ),
            key.clone(),
        ))
    }

    pub(in crate::management) fn take_lifecycle_fact(&mut self) -> Option<PreparedFactEmission> {
        self.lifecycle_fact_outbox.pop()
    }

    pub(in crate::management) fn pending_lifecycle_facts(&self) -> usize {
        self.lifecycle_fact_outbox.len()
    }
}

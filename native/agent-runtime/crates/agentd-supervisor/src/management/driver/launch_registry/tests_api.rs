use super::record::AcceptedLaunchSnapshot;
use super::{LaunchIntentKey, LaunchRegistry};
use crate::management::driver::plan::LaunchPlan;
use crate::process_table::OwnershipKey;

impl LaunchRegistry {
    pub(in crate::management::driver) fn mark_owned_for_test(
        &mut self,
        intent: &LaunchIntentKey,
        plan: &LaunchPlan,
    ) -> bool {
        self.mark_owned(intent, plan, AcceptedLaunchSnapshot::for_test(plan))
    }

    pub(in crate::management::driver) fn state_for_test(
        &self,
        idempotency_key: &str,
    ) -> Option<(usize, bool, bool, bool, bool)> {
        self.by_idempotency_key.get(idempotency_key).map(|record| {
            (
                record.unacked_facts,
                record.host_durable,
                record.physical_cleanup_required,
                record.physical_reaped,
                record.eligible_for_eviction(),
            )
        })
    }

    pub(in crate::management::driver) fn ownership_key_for_test(
        &self,
        idempotency_key: &str,
    ) -> Option<&OwnershipKey> {
        self.by_idempotency_key
            .get(idempotency_key)
            .map(|record| &record.ownership_key)
    }
}
